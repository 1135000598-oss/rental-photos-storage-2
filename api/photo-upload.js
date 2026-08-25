// Vercel Serverless Function: 照片上传代理（GitHub 仓库图床）
// 前端 POST { dataUrl, houseCode, fileName }，
// 后端把 base64 解码后通过 GitHub Contents API 上传到配置的仓库，返回 { githubUrl, size }
//
// 环境变量:
//   GITHUB_TOKEN: GitHub Personal Access Token（需 repo 权限）
//   GITHUB_REPO: 格式 "用户名/仓库名"，如 "wangting/rental-photos-storage"

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Manager-Name, X-Manager-Code');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(503).json({
      success: false,
      error: 'GitHub 图床未配置：请在 Vercel 环境变量设置 GITHUB_TOKEN 和 GITHUB_REPO'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { dataUrl, houseCode, fileName } = body || {};
    if (!dataUrl || !houseCode) {
      return res.status(400).json({ success: false, error: '需要 dataUrl 和 houseCode' });
    }

    // 解析 dataUrl
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ success: false, error: 'dataUrl 格式不正确' });
    const contentType = m[1] || 'image/jpeg';
    const buf = Buffer.from(m[2], 'base64');

    // GitHub 限制单文件 100MB，前端已压到 ≤500KB
    if (buf.length > 5 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: '图片太大（>5MB），请重新压缩' });
    }

    // 生成路径：photos/{houseCode}/{timestamp}_{random}.{ext}
    const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const ext = (fileName && fileName.match(/\.(jpe?g|png|webp)$/i)) ? RegExp.$1.toLowerCase().replace('jpeg', 'jpg') : 'jpg';
    const path = 'photos/' + houseCode + '/' + id + '.' + ext;

    // 通过 GitHub Contents API 上传
    const r = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + path, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'rental-photos-server'
      },
      body: JSON.stringify({
        message: 'upload photo: ' + houseCode + ' ' + id,
        content: m[2] // GitHub 接受纯 base64，不要带 dataUrl 前缀
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ success: false, error: 'GitHub 上传失败: ' + r.status + ' ' + t.slice(0, 300) });
    }

    const data = await r.json();
    // 用 jsdelivr CDN 加速（公开仓库才有，私有仓库用 raw.githubusercontent.com）
    const cdnUrl = 'https://cdn.jsdelivr.net/gh/' + GITHUB_REPO + '@main/' + path;
    const rawUrl = data.content && data.content.download_url;

    return res.status(200).json({
      success: true,
      githubUrl: cdnUrl,
      rawUrl: rawUrl || cdnUrl,
      path: path,
      size: buf.length
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};