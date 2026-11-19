const pool = require('../db/pool');
const { withTransaction } = require('../db/tx');
const { SLA_MINUTES, REQUESTER_ROLES } = require('../config/constants');

// GET /api/catalog — list active catalog items (with fields)
async function getCatalogItems(req, res) {
  const { rows: items } = await pool.query(
    `SELECT * FROM catalog_items WHERE is_active = TRUE ORDER BY sort_order, name`
  );

  const { rows: fields } = await pool.query(
    `SELECT * FROM catalog_fields
     WHERE catalog_item_id = ANY($1)
     ORDER BY catalog_item_id, sort_order`,
    [items.map((i) => i.id)]
  );

  const fieldsByItem = {};
  for (const f of fields) {
    if (!fieldsByItem[f.catalog_item_id]) fieldsByItem[f.catalog_item_id] = [];
    fieldsByItem[f.catalog_item_id].push(f);
  }

  const result = items.map((item) => ({
    ...item,
    fields: fieldsByItem[item.id] || [],
  }));

  res.json({ items: result });
}

// GET /api/catalog/:id
async function getCatalogItem(req, res) {
  const {
    rows: [item],
  } = await pool.query(`SELECT * FROM catalog_items WHERE id = $1 AND is_active = TRUE`, [
    req.params.id,
  ]);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });

  const { rows: fields } = await pool.query(
    `SELECT * FROM catalog_fields WHERE catalog_item_id = $1 ORDER BY sort_order`,
    [item.id]
  );

  res.json({ item: { ...item, fields } });
}

// POST /api/catalog/:id/submit — create ticket from catalog item
async function submitCatalogItem(req, res) {
  const {
    rows: [item],
  } = await pool.query(`SELECT * FROM catalog_items WHERE id = $1 AND is_active = TRUE`, [
    req.params.id,
  ]);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });

  const { body, additionalInfo } = req.body;
  const isRequester = REQUESTER_ROLES.includes(req.user.role);

  // Build description from submitted field values
  let description = '';
  if (body && typeof body === 'object') {
    const entries = Object.entries(body)
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => `**${k.replace(/_/g, ' ')}:** ${v}`);
    description = entries.join('\n');
  }
  if (additionalInfo) description += `\n\n**Additional info:** ${additionalInfo}`;
  if (!description.trim()) description = `Request for: ${item.name}`;

  const requesterName = isRequester ? req.user.name : req.body.requesterName || req.user.name;
  const requesterEmail = isRequester ? req.user.email : req.body.requesterEmail || req.user.email;
  const priority = isRequester ? 'P3' : item.default_priority || 'P3';
  const slaMinutes = SLA_MINUTES[priority] || SLA_MINUTES.P3;
  const initialStatus = item.requires_approval ? 'Pending Approval' : 'New';

  const { rows: managers } = await pool.query(
    `SELECT id FROM users WHERE role IN ('admin','manager') AND is_active = TRUE`
  );

  // Ticket, approval record and manager notifications land together or not at all
  const ticket = await withTransaction(async (client) => {
    const {
      rows: [t],
    } = await client.query(
      `INSERT INTO tickets
         (title, description, type, priority, sla_minutes, status, source,
          requester_name, requester_email,
          created_by_user_id, catalog_item_id)
       VALUES ($1,$2,'Service Request',$3,$4,$5,'catalog',$6,$7,$8,$9)
       RETURNING *`,
      [
        item.name,
        description.trim(),
        priority,
        slaMinutes,
        initialStatus,
        requesterName,
        requesterEmail,
        req.user.userId,
        item.id,
      ]
    );

    if (item.requires_approval) {
      await client.query(`INSERT INTO approvals (ticket_id) VALUES ($1)`, [t.id]);
    }

    const [type, msg] = item.requires_approval
      ? ['approval_needed', `Approval needed: "${item.name}" requested by ${requesterName}.`]
      : ['new_ticket', `New service request: "${item.name}" submitted by ${requesterName}.`];
    for (const m of managers) {
      await client.query(
        `INSERT INTO notifications (user_id, ticket_id, type, message) VALUES ($1,$2,$3,$4)`,
        [m.id, t.id, type, msg]
      );
    }
    return t;
  });

  res.status(201).json({ ticket });
}

module.exports = { getCatalogItems, getCatalogItem, submitCatalogItem };
