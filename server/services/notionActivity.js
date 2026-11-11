// Notion activity feed for /api/status (moved out of server.js; this module
// was the unused duplicate and is now the one implementation).
function createNotionActivityService({ notionDbId, notionToken, fetchImpl = (...args) => fetch(...args) }) {
  async function fetchNotionActivity(pageSize = 5) {
    if (!notionDbId || !notionToken) return null;

    try {
      const res = await fetchImpl(`https://api.notion.com/v1/databases/${notionDbId}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${notionToken}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          page_size: pageSize,
          sorts: [{ property: 'Date', direction: 'descending' }],
        }),
      });

      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data.results) || data.results.length === 0) return null;

      return data.results.map((page) => {
        const props = page.properties || {};
        const name = (props.Name?.title || []).map((item) => item.plain_text).join('') || 'Activity';
        const dateStr = props.Date?.date?.start || page.created_time || new Date().toISOString();
        const category = props.Category?.select?.name || 'general';
        const status = props.Status?.select?.name || props.Status?.status?.name || 'done';
        const details = (props.Details?.rich_text || []).map((item) => item.plain_text).join('') || '';

        const typeMap = {
          Development: 'development',
          Business: 'business',
          Meeting: 'meeting',
          Planning: 'planning',
          'Bug Fix': 'development',
          Personal: 'personal',
        };

        return {
          time: dateStr,
          action: name,
          detail: details || `${category} — ${status}`,
          type: typeMap[category] || 'general',
        };
      });
    } catch (error) {
      console.error('[Notion API]', error.message);
      return null;
    }
  }

  return {
    fetchNotionActivity,
  };
}

module.exports = {
  createNotionActivityService,
};
