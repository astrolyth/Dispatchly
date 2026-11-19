const pool = require('../db/pool');
const { withTransaction } = require('../db/tx');

// ─── GET /api/problems ───────────────────────────────────────────────────────

async function getProblems(_req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              u.name AS assigned_to_name,
              cb.name AS created_by_name,
              COUNT(pt.ticket_id) AS linked_tickets_count
       FROM problems p
       LEFT JOIN users u   ON u.id  = p.assigned_to_user_id
       LEFT JOIN users cb  ON cb.id = p.created_by_user_id
       LEFT JOIN problem_tickets pt ON pt.problem_id = p.id
       GROUP BY p.id, u.name, cb.name
       ORDER BY p.created_at DESC`
    );
    res.json({ problems: rows });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/problems ──────────────────────────────────────────────────────

async function createProblem(req, res, next) {
  try {
    const { title, description, assigned_to_user_id } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }

    const {
      rows: [problem],
    } = await pool.query(
      `INSERT INTO problems (title, description, assigned_to_user_id, created_by_user_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [title, description, assigned_to_user_id || null, req.user.userId]
    );

    res.status(201).json({ problem });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/problems/:id ───────────────────────────────────────────────────

async function getProblem(req, res, next) {
  try {
    const {
      rows: [problem],
    } = await pool.query(
      `SELECT p.*,
              u.name  AS assigned_to_name,
              cb.name AS created_by_name
       FROM problems p
       LEFT JOIN users u   ON u.id  = p.assigned_to_user_id
       LEFT JOIN users cb  ON cb.id = p.created_by_user_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!problem) return res.status(404).json({ error: 'Problem not found' });

    // Linked tickets
    const { rows: tickets } = await pool.query(
      `SELECT t.id, t.title, t.status, t.priority, t.requester_name, t.created_at
       FROM problem_tickets pt
       JOIN tickets t ON t.id = pt.ticket_id
       WHERE pt.problem_id = $1
       ORDER BY t.created_at DESC`,
      [req.params.id]
    );

    res.json({ problem: { ...problem, tickets } });
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /api/problems/:id ─────────────────────────────────────────────────

async function updateProblem(req, res, next) {
  try {
    const ALLOWED = ['title', 'description', 'status', 'root_cause', 'workaround', 'resolution', 'assigned_to_user_id'];
    const sets = [];
    const values = [];

    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = $${values.length + 1}`);
        values.push(req.body[key]);
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    sets.push(`updated_at = $${values.length + 1}`);
    values.push(new Date());
    values.push(req.params.id);

    const {
      rows: [problem],
    } = await pool.query(
      `UPDATE problems SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (!problem) return res.status(404).json({ error: 'Problem not found' });
    res.json({ problem });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/problems/:id/link ─────────────────────────────────────────────

async function linkTickets(req, res, next) {
  try {
    const { ticket_ids } = req.body;
    if (!Array.isArray(ticket_ids) || ticket_ids.length === 0) {
      return res.status(400).json({ error: 'ticket_ids must be a non-empty array' });
    }

    await Promise.all(
      ticket_ids.map((tid) =>
        pool.query(
          `INSERT INTO problem_tickets (problem_id, ticket_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [req.params.id, tid]
        )
      )
    );

    res.json({ ok: true, linked: ticket_ids.length });
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /api/problems/:id/tickets/:ticketId ──────────────────────────────

async function unlinkTicket(req, res, next) {
  try {
    await pool.query(
      'DELETE FROM problem_tickets WHERE problem_id = $1 AND ticket_id = $2',
      [req.params.id, req.params.ticketId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/problems/:id/resolve ─────────────────────────────────────────
// Resolves the problem and auto-resolves all linked tickets

async function resolveProblem(req, res, next) {
  try {
    const { resolution } = req.body;

    // Problem + linked tickets + notifications resolve together or not at all.
    // The status check is inside the UPDATE so a double click can't resolve twice.
    const result = await withTransaction(async (client) => {
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE problems
           SET status = 'Resolved', resolution = $1, resolved_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND status NOT IN ('Resolved','Closed')
         RETURNING *`,
        [resolution || null, req.params.id]
      );
      if (!updated) return null;

      const resolveMsg = `Auto-resolved: linked Problem #${updated.id} was resolved. ${resolution ? `Resolution: ${resolution}` : ''}`.trim();
      const { rows: tickets } = await client.query(
        `UPDATE tickets t
           SET status = 'Resolved', resolution_notes = $1, resolved_at = NOW(), updated_at = NOW()
         FROM problem_tickets pt
         WHERE pt.ticket_id = t.id AND pt.problem_id = $2
           AND t.status NOT IN ('Resolved','Closed')
         RETURNING t.id, t.title, t.created_by_user_id`,
        [resolveMsg, updated.id]
      );

      for (const t of tickets.filter((x) => x.created_by_user_id)) {
        const shortTitle = t.title.slice(0, 60) + (t.title.length > 60 ? '…' : '');
        await client.query(
          `INSERT INTO notifications (user_id, ticket_id, type, message)
           VALUES ($1,$2,'ticket_updated',$3)`,
          [
            t.created_by_user_id,
            t.id,
            `Your ticket "${shortTitle}" was resolved as part of Problem #${updated.id}`,
          ]
        );
      }
      return { problem: updated, resolvedTickets: tickets.length };
    });

    if (!result) {
      const { rowCount } = await pool.query('SELECT 1 FROM problems WHERE id = $1', [req.params.id]);
      return rowCount
        ? res.status(400).json({ error: 'Problem is already resolved' })
        : res.status(404).json({ error: 'Problem not found' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/tickets/:id/problems ───────────────────────────────────────────
// Returns problems linked to a specific ticket

async function getTicketProblems(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.status, p.root_cause, p.workaround, p.created_at
       FROM problem_tickets pt
       JOIN problems p ON p.id = pt.problem_id
       WHERE pt.ticket_id = $1
       ORDER BY p.created_at DESC`,
      [req.params.id]
    );
    res.json({ problems: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProblems,
  createProblem,
  getProblem,
  updateProblem,
  linkTickets,
  unlinkTicket,
  resolveProblem,
  getTicketProblems,
};
