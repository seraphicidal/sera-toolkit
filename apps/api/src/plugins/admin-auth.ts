import { matchesToken } from './client.js';

export function checkAdminAuth(header: string | undefined, adminToken: string): boolean {
  if (!adminToken) return false;
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return matchesToken(presented, adminToken);
}
