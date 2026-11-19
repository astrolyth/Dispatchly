const pool = require('../db/pool');
const { withTransaction } = require('../db/tx');

// GET /api/tickets/:id/approval — get approval record for a ticket
async function getApproval(req, res) {
  const {
    rows: [approval],
  } = await pool.query(
    `SELECT a.*, u.name AS approver_name
     FROM   approvals a
     LEFT   JOIN users u ON u.id = a.approver_id
     WHERE  a.ticket_id = $1`,
    [req.params.id]
  );
  res.json({ approval: approval || null });
}

/**
 * Move a 'Pending Approval' ticket to its next state, record the decision and notify
 * the requester — all in one transaction. The status check is part of the UPDATE, so
 * two managers clicking approve/reject at once can't both win.
 */
async function decide(req, res, { approvalStatus, ticketSql, ticketParams, message }) {
  const { comment } = req.body;

  const ticket = await withTransaction(async (client) => {
    const {
      rows: [t],
    } = await client.query(ticketSql, ticketParams);
    if (!t) return null;

    await client.query(
      `UPDATE approvals
       SET status = $1, approver_id = $2, comment = $3, resolved_at = NOW()
       WHERE ticket_id = $4`,
      [approvalStatus, req.user.userId, comment || null, t.id]
    );

    if (t.created_by_user_id) {
      await client.query(
        `INSERT INTO notifications (user_id, ticket_id, type, message)
         VALUES ($1,$2,'approval_resolved',$3)`,
        [t.created_by_user_id, t.id, message(t)]
      );
    }
    return t;
  });

  if (!ticket) {
    const { rowCount } = await pool.query('SELECT 1 FROM tickets WHERE id = $1', [req.params.id]);
    return rowCount
      ? res.status(400).json({ error: 'Ticket is not pending approval' })
      : res.status(404).json({ error: 'Ticket not found' });
  }
  res.json({ ticket });
}

// POST /api/tickets/:id/approve — advance ticket to New
async function approveTicket(req, res) {
  return decide(req, res, {
    approvalStatus: 'approved',
    ticketSql: `UPDATE tickets SET status = 'New', updated_at = NOW()
                WHERE id = $1 AND status = 'Pending Approval' RETURNING *`,
    ticketParams: [req.params.id],
    message: (t) => `Your request "${t.title}" was approved. Work will begin shortly.`,
  });
}

// POST /api/tickets/:id/reject — close ticket with a rejection note
async function rejectTicket(req, res) {
  const { comment } = req.body;
  const rejectionNote = comment
    ? `Request rejected by ${req.user.name}: ${comment}`
    : `Request rejected by ${req.user.name}.`;

  return decide(req, res, {
    approvalStatus: 'rejected',
    ticketSql: `UPDATE tickets
                SET status = 'Closed', resolution_notes = $2, closed_at = NOW(), updated_at = NOW()
                WHERE id = $1 AND status = 'Pending Approval' RETURNING *`,
    ticketParams: [req.params.id, rejectionNote],
    message: (t) =>
      `Your request "${t.title}" was not approved. ${comment ? `Reason: ${comment}` : ''}`.trim(),
  });
}

module.exports = { getApproval, approveTicket, rejectTicket };
