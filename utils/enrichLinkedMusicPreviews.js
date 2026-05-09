/**
 * Fills missing iTunes track preview URLs on post linked media (feed hydration).
 */

async function fetchItunesPreviewByTrackIds(trackIds) {
  const ids = [...new Set((trackIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();

  const map = new Map();
  const chunkSize = 40;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(chunk.join(','))}`);
      if (!res.ok) continue;
      const json = await res.json();
      for (const r of json.results || []) {
        if (r.trackId != null && r.previewUrl) {
          map.set(String(r.trackId), r.previewUrl);
        }
      }
    } catch {
      // ignore network / parse errors
    }
  }

  return map;
}

function collectItunesMusicIdsNeedingPreview(post) {
  const out = [];
  const consider = (m) => {
    if (!m) return;
    if (String(m.type || '').toLowerCase() !== 'music') return;
    if (m.preview_url) return;
    if (String(m.source || '').toLowerCase() !== 'itunes') return;
    const mid = m.media_id != null ? String(m.media_id).trim() : '';
    if (mid) out.push(mid);
  };
  (post.linked_medias || []).forEach(consider);
  consider(post.linked_media);
  return out;
}

function enrichLinkedItem(m, previewMap) {
  if (!m) return m;
  if (String(m.type || '').toLowerCase() !== 'music' || m.preview_url) return m;
  if (String(m.source || '').toLowerCase() !== 'itunes' || m.media_id == null) return m;
  const url = previewMap.get(String(m.media_id));
  return url ? { ...m, preview_url: url } : m;
}

/**
 * @param {object[]} posts Lean post documents
 * @returns {Promise<object[]>} New array with linked_media / linked_medias preview_url filled when possible
 */
async function enrichPostsLinkedMusicPreviews(posts) {
  if (!posts.length) return posts;

  const idSet = new Set();
  for (const p of posts) {
    collectItunesMusicIdsNeedingPreview(p).forEach((id) => idSet.add(id));
  }
  if (!idSet.size) return posts;

  const previewMap = await fetchItunesPreviewByTrackIds([...idSet]);

  return posts.map((p) => ({
    ...p,
    linked_media: enrichLinkedItem(p.linked_media, previewMap),
    linked_medias: (p.linked_medias || []).map((m) => enrichLinkedItem(m, previewMap)),
  }));
}

module.exports = { enrichPostsLinkedMusicPreviews };
