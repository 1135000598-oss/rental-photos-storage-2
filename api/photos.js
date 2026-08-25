// Vercel Serverless Function: 照片元数据 + 备注 API
// 数据流：图存 GitHub 仓库（通过 /api/photo-upload），这里只存元数据
//
// 字段格式：
//   photo:{houseCode}:{id} -> { id, houseCode, name, githubUrl, path, time, size, manager }
//   note:{houseCode} -> { text, time }
//   sync_time -> ISO 时间戳
//
// 环境变量:
//   EDGE_CONFIG: Vercel 自动注入
//   VERCEL_TOKEN: 调用 Edge Config REST API
//   WECOM_WEBHOOK: 企微通知 URL

const EDGE_CONFIG_ID = 'ecfg_ep7rtngkdhqqdafu9s2rwmbekwqy';
const WECOM_WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=edc13b52-da50-4813-994b-8e26b0b29cf4';

async function notifyWecom(content) {
  try {
    await fetch(WECOM_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: content } })
    });
  } catch (e) { /* 通知失败不影响主流程 */ }
}

async function ecGetAll() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN not configured');
  const r = await fetch(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`Edge Config GET ${r.status}`);
  return await r.json();
}

async function ecUpsert(items) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN not configured');
  const r = await fetch(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });
  if (!r.ok) throw new Error(`Edge Config PATCH ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function ecDelete(key) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN not configured');
  const r = await fetch(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ operation: 'delete', key }] })
  });
  if (!r.ok) throw new Error(`Edge Config DELETE ${r.status}`);
  return await r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Manager-Name, X-Manager-Code');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET /api/photos - 拉取所有照片元数据
  if (req.method === 'GET') {
    try {
      const noteMode = req.query && req.query.type === 'notes';
      const items = await ecGetAll();

      if (noteMode) {
        const notes = {};
        for (const item of items) {
          if (item.key.startsWith('note:')) {
            const houseCode = item.key.replace('note:', '');
            const val = typeof item.value === 'string' ? JSON.parse(item.value) : item.value;
            if (val && val.text) notes[houseCode] = val.text;
          }
        }
        return res.status(200).json({ success: true, notes });
      }

      const result = {};
      for (const item of items) {
        if (item.key.startsWith('photo:')) {
          const data = typeof item.value === 'string' ? JSON.parse(item.value) : item.value;
          const houseCode = item.key.replace('photo:', '').split(':')[0];
          if (!result[houseCode]) result[houseCode] = [];
          result[houseCode].push(data);
        }
      }
      const syncTimeItem = items.find(i => i.key === 'sync_time');
      const syncTime = syncTimeItem ? (typeof syncTimeItem.value === 'string' ? syncTimeItem.value : JSON.stringify(syncTimeItem.value)) : '';
      return res.status(200).json({ success: true, photos: result, syncTime });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // POST /api/photos?type=note - 备注保存
  if (req.method === 'POST' && req.query && req.query.type === 'note') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body.houseCode) return res.status(400).json({ success: false, error: '需要 houseCode' });
      const noteKey = 'note:' + body.houseCode;
      const text = (body.text || '').slice(0, 500);
      await ecUpsert([
        { operation: 'upsert', key: noteKey, value: { text: text, time: new Date().toISOString() } },
        { operation: 'upsert', key: 'sync_time', value: new Date().toISOString() }
      ]);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // POST /api/photos - 写元数据（图已通过 /api/photo-upload 上传到 GitHub）
  if (req.method === 'POST') {
    try {
      const managerName = req.headers['x-manager-name'] || '';
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (!body.houseCode || !body.photos || !Array.isArray(body.photos)) {
        return res.status(400).json({ success: false, error: '参数不正确' });
      }

      const newItems = [];
      for (const photo of body.photos) {
        const id = photo.id || (Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
        const key = 'photo:' + body.houseCode + ':' + id;
        const record = {
          id,
          houseCode: body.houseCode,
          name: photo.name || '',
          githubUrl: photo.githubUrl || '',
          path: photo.path || '',
          time: photo.time || new Date().toISOString(),
          size: photo.size || 0,
          manager: managerName
        };
        // 兼容旧数据
        if (!record.githubUrl && photo.data) record.data = photo.data;
        newItems.push({ operation: 'upsert', key, value: record });
      }

      newItems.push({ operation: 'upsert', key: 'sync_time', value: new Date().toISOString() });
      await ecUpsert(newItems);

      // 企微通知
      const now = new Date();
      const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
      const msg = '【照片上传提醒】\n资管 ' + managerName + ' 上传了 ' + body.photos.length + ' 张照片\n房源编码：' + body.houseCode + '\n时间：' + timeStr;
      notifyWecom(msg);

      return res.status(200).json({ success: true, saved: body.photos.length, manager: managerName });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // DELETE /api/photos - 删除单张照片（元数据 + GitHub 文件）
  if (req.method === 'DELETE') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body.houseCode || !body.id) {
        return res.status(400).json({ success: false, error: '需要 houseCode 和 id' });
      }
      const key = 'photo:' + body.houseCode + ':' + body.id;
      // 如有 path，从 GitHub 删文件
      if (body.path && process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
        try {
          // 先 GET 拿到 sha（GitHub 删除需要 sha）
          const getR = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + body.path, {
            headers: {
              'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'rental-photos-server'
            }
          });
          if (getR.ok) {
            const fileInfo = await getR.json();
            await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + body.path, {
              method: 'DELETE',
              headers: {
                'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
                'User-Agent': 'rental-photos-server'
              },
              body: JSON.stringify({ message: 'delete photo: ' + body.id, sha: fileInfo.sha })
            });
          }
        } catch (e) { console.warn('GitHub delete failed:', e.message); }
      }
      await ecDelete(key);
      await ecUpsert([{ operation: 'upsert', key: 'sync_time', value: new Date().toISOString() }]);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
};