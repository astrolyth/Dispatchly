const { REQUESTER_ROLES } = require('../config/constants');

// Same visibility rule as GET /api/tickets: requesters see their own tickets,
// technicians see tickets assigned to them, other staff see everything.
function canViewTicket(user, ticket) {
  if (REQUESTER_ROLES.includes(user.role)) return ticket.created_by_user_id === user.userId;
  if (user.role === 'technician') return ticket.assigned_to_user_id === user.userId;
  return true;
}

module.exports = { canViewTicket };
