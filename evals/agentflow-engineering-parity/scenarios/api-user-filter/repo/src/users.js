const USERS = [
  { id: "u1", name: "Mina", role: "teacher", active: true },
  { id: "u2", name: "Ari", role: "student", active: false },
  { id: "u3", name: "Zoe", role: "student", active: true }
];

export function listUsers(query = {}) {
  let users = USERS;

  if (query.role) {
    users = users.filter((user) => user.role === query.role);
  }

  return users;
}
