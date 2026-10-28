// 启动后台函数（它们会立刻返回 202，实际工作在后台继续）
export async function kick(origin, name, slug) {
  const res = await fetch(`${origin}/.netlify/functions/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`启动后台任务失败（${name}）：HTTP ${res.status}`);
}
