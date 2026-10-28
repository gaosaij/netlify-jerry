// 管理接口鉴权：请求头 x-admin-password 必须等于环境变量 ADMIN_PASSWORD
import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// 通过返回 null，不通过返回要直接响应给客户端的 Response
export function requireAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return json({ error: '服务端还没有配置 ADMIN_PASSWORD 环境变量' }, 503);
  const given = req.headers.get('x-admin-password') || '';
  if (!timingSafeEqual(sha(given), sha(expected))) return json({ error: '管理密码不正确' }, 401);
  return null;
}
