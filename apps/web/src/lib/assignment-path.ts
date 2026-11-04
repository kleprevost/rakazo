/** Where an assignment opens, from Today, the board, the employee panel and notifications. */
export const assignmentPath = (assignmentId: string) =>
  `/app/a/${encodeURIComponent(assignmentId)}`;
