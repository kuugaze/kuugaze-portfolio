// Processes a "site-update" issue created from the portfolio site's admin panel.
// The issue body contains a fenced JSON payload plus, optionally, image
// attachments the admin dragged into marked sections. This script reads
// that payload, uploads any new images, updates works.json / about.json,
// and reports back on the issue.

module.exports.processIssue = async function processIssue({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const issue = context.payload.issue;
  const issueNumber = issue.number;
  const body = issue.body || '';
  const SITE_URL = 'https://kuugaze.github.io/kuugaze-portfolio/';

  async function comment(message) {
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: message });
  }
  async function close() {
    await github.rest.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
  }

  async function getFile(filePath) {
    try {
      const res = await github.rest.repos.getContent({ owner, repo, path: filePath });
      return { sha: res.data.sha, content: Buffer.from(res.data.content, 'base64').toString('utf8') };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async function putTextFile(filePath, content, message, sha) {
    await github.rest.repos.createOrUpdateFileContents({
      owner, repo, path: filePath, message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: sha || undefined,
      branch: 'main'
    });
  }

  async function putBinaryFile(filePath, base64, message) {
    let sha;
    try {
      const res = await github.rest.repos.getContent({ owner, repo, path: filePath });
      sha = res.data.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    await github.rest.repos.createOrUpdateFileContents({
      owner, repo, path: filePath, message,
      content: base64, sha: sha || undefined, branch: 'main'
    });
  }

  async function downloadImageAsBase64(url) {
    let res = await fetch(url);
    if (!res.ok) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}` } });
    }
    if (!res.ok) throw new Error(`画像のダウンロードに失敗しました (${res.status}): ${url}`);
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('gif') ? 'gif'
      : 'jpg';
    const buf = Buffer.from(await res.arrayBuffer());
    return { base64: buf.toString('base64'), ext };
  }

  try {
    const jsonMatch = body.match(/SITE-UPDATE-PAYLOAD-START\s*```json\s*([\s\S]*?)```\s*SITE-UPDATE-PAYLOAD-END/);
    if (!jsonMatch) {
      await comment('⚠️ このIssueから設定データを読み取れませんでした。管理画面から操作をやり直してください(本文を編集せずにそのまま送信したか確認してください)。');
      return;
    }
    const payload = JSON.parse(jsonMatch[1]);

    // Collect any images the admin dropped into "#### IMG:<token>" sections.
    const imagesByToken = {};
    const sectionRegex = /####\s*IMG:(\S+)[^\n]*\n([\s\S]*?)(?=####\s*IMG:|$)/g;
    let m;
    while ((m = sectionRegex.exec(body)) !== null) {
      const token = m[1];
      const section = m[2];
      const linkMatch = section.match(/!\[[^\]]*\]\(([^)]+)\)/);
      if (linkMatch) imagesByToken[token] = linkMatch[1];
    }

    if (payload.type === 'about') {
      const existing = await getFile('about.json');
      const about = existing ? JSON.parse(existing.content) : {};
      about.subtitle = payload.subtitle || 'about';
      about.jp = payload.jp || '';
      about.meta = payload.meta || '';
      await putTextFile('about.json', JSON.stringify(about, null, 2) + '\n',
        `Update about via issue #${issueNumber}`, existing ? existing.sha : undefined);
      await comment(`✅ Aboutを更新しました。数分でサイトに反映されます: ${SITE_URL}`);
      await close();
      return;
    }

    if (payload.type === 'reorder') {
      const existing = await getFile('works.json');
      if (!existing) throw new Error('works.json が見つかりません');
      const works = JSON.parse(existing.content);
      const orderIndex = new Map((payload.order || []).map((k, i) => [k, i]));
      works.sort((a, b) => {
        const ai = orderIndex.has(a.key) ? orderIndex.get(a.key) : 999999;
        const bi = orderIndex.has(b.key) ? orderIndex.get(b.key) : 999999;
        return ai - bi;
      });
      const hiddenSet = new Set(payload.hidden || []);
      works.forEach(w => {
        if (hiddenSet.has(w.key)) w.hidden = true;
        else delete w.hidden;
      });
      await putTextFile('works.json', JSON.stringify(works, null, 2) + '\n',
        `Reorder/hide works via issue #${issueNumber}`, existing.sha);
      await comment(`✅ 並び替え・公開状態を更新しました。数分でサイトに反映されます: ${SITE_URL}`);
      await close();
      return;
    }

    if (payload.type === 'work') {
      const existing = await getFile('works.json');
      if (!existing) throw new Error('works.json が見つかりません');
      const works = JSON.parse(existing.content);

      const entry = payload.original ? { ...payload.original } : {};
      const key = payload.key || `work-${issueNumber}`;
      entry.key = key;
      entry.category = payload.category || '';
      entry.title = payload.title || '';
      entry.subtitle = payload.subtitle || '';
      entry.jp = payload.jp || '';
      if (payload.en) entry.en = payload.en; else delete entry.en;
      if (payload.meta) entry.meta = payload.meta; else delete entry.meta;
      if (payload.note) entry.note = payload.note; else delete entry.note;
      if (payload.embed) entry.embed = payload.embed; else delete entry.embed;

      if (payload.newThumbnail && imagesByToken[payload.newThumbnail]) {
        const { base64, ext } = await downloadImageAsBase64(imagesByToken[payload.newThumbnail]);
        const thumbPath = `images/${key}.${ext}`;
        await putBinaryFile(thumbPath, base64, `Upload thumbnail for ${key} via issue #${issueNumber}`);
        entry.thumb = thumbPath;
      } else if (payload.currentThumb) {
        entry.thumb = payload.currentThumb;
      }

      const images = [...(payload.existingImages || [])];
      const newGallery = payload.newGalleryImages || [];
      for (let i = 0; i < newGallery.length; i++) {
        const token = newGallery[i];
        const srcUrl = imagesByToken[token];
        if (!srcUrl) continue;
        const { base64, ext } = await downloadImageAsBase64(srcUrl);
        const galPath = `images/${key}_${images.length + 1}.${ext}`;
        await putBinaryFile(galPath, base64, `Upload gallery image for ${key} via issue #${issueNumber}`);
        images.push(galPath);
      }
      if (images.length) entry.images = images; else delete entry.images;

      const idx = works.findIndex(w => w.key === key);
      if (idx >= 0) works[idx] = entry;
      else works.push(entry);

      await putTextFile('works.json', JSON.stringify(works, null, 2) + '\n',
        `${payload.key ? 'Update' : 'Add'} work "${entry.title}" via issue #${issueNumber}`, existing.sha);
      await comment(`✅ 作品「${entry.title}」を${payload.key ? '更新' : '追加'}しました。数分でサイトに反映されます: ${SITE_URL}`);
      await close();
      return;
    }

    await comment(`⚠️ 不明な種類のデータです (type: ${payload.type})`);
  } catch (err) {
    core.setFailed(err.message);
    try {
      await comment(`❌ 反映中にエラーが発生しました:\n\`\`\`\n${err.message}\n\`\`\`\nもう一度管理画面からやり直すか、内容を確認してください。`);
    } catch (e2) {
      // ignore
    }
  }
};

