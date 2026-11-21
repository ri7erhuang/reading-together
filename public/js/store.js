export const store = {
  users: [],
  userId: 'dad',
  books: [],
  totals: { total: 0, dad: 0, son: 0, ai: 0 },
  llm: { enabled: false },
  bootstrapAt: 0
};

export function userName(id) {
  if (id === 'ai') return 'AI';
  const u = store.users.find((x) => x.id === id);
  return u ? u.name : (id === 'son' ? '儿子' : '爸爸');
}

export function userRole(id) {
  return id === 'son' ? 'son' : 'dad';
}
