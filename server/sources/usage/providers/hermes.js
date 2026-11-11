'use strict';
const path = require('node:path');
const { readJson } = require('./command');
const { hash } = require('../incremental-jsonl');
const { unavailable } = require('./contract');
function hermesDbPath(env = process.env, home = env.MC_USER_HOME || env.HOME) {
    if (env.HERMES_STATE_DB)
        return env.HERMES_STATE_DB;
    if (env.HERMES_PROFILE_DIR)
        return path.join(env.HERMES_PROFILE_DIR, 'state.db');
    return path.join(home, '.hermes', 'profiles', env.HERMES_PROFILE || 'hmudur', 'state.db');
}
function createHermesProvider({ exec, home, env = {}, now = Date.now }) {
    const db = hermesDbPath(env, home);
    return {
        id: 'hermes', label: 'Hermes', identity: db, timeoutMs: 6000,
        async read({ since, until }) {
            const observedAt = new Date(now()).toISOString();
            const start = Math.floor(new Date(since + 'T00:00:00').getTime() / 1000), end = Math.floor(new Date(until + 'T23:59:59.999').getTime() / 1000);
            if (!Number.isFinite(start) || !Number.isFinite(end))
                throw unavailable('invalid_usage');
            // Derive only a boolean inside SQLite. No endpoint, credential or full
            // model configuration crosses the producer boundary. A provider/model
            // name alone never establishes that inference ran on a local endpoint.
            const localAuthorities = ['localhost', '127.0.0.1', '[::1]'];
            const localEndpoint = localAuthorities.map(host => `(endpointAuthority='${host}' OR (substr(endpointAuthority,1,${host.length + 1})='${host}:' AND substr(endpointAuthority,${host.length + 2})<>'' AND substr(endpointAuthority,${host.length + 2}) NOT GLOB '*[^0-9]*' AND CAST(substr(endpointAuthority,${host.length + 2}) AS INTEGER) BETWEEN 1 AND 65535))`).join(' OR ');
            const sql = `WITH endpoint_rows AS (
                SELECT model_config,started_at,billing_provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,actual_cost_usd,
                    CASE WHEN lower(trim(billing_base_url)) LIKE 'http://%' THEN substr(lower(trim(billing_base_url)),8) WHEN lower(trim(billing_base_url)) LIKE 'https://%' THEN substr(lower(trim(billing_base_url)),9) END AS endpointTail
                FROM sessions WHERE started_at>=${start} AND started_at<=${end}
            ), counted_rows AS (
                SELECT model_config,started_at,billing_provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,actual_cost_usd,
                    substr(endpointTail,1,instr(endpointTail||'/','/')-1) AS endpointAuthority FROM endpoint_rows
            ) SELECT CASE WHEN ${localEndpoint} THEN 1 ELSE NULL END AS isLocal,
                CASE WHEN json_valid(model_config) THEN CASE WHEN json_type(model_config,'$.codex_thread_id')='text' THEN json_extract(model_config,'$.codex_thread_id') END END AS rolloutId, date(started_at,'unixepoch','localtime') AS date, COALESCE(NULLIF(billing_provider,''),'unknown') AS provider, COALESCE(NULLIF(model,''),'unknown') AS model, SUM(COALESCE(input_tokens,0)) AS inputTokens, SUM(COALESCE(output_tokens,0)) AS outputTokens, SUM(COALESCE(cache_read_tokens,0)) AS cacheReadTokens, SUM(COALESCE(cache_write_tokens,0)) AS cacheWriteTokens, SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL OR cache_read_tokens IS NULL OR cache_write_tokens IS NULL THEN 1 ELSE 0 END) AS unknownTokenRows, CASE WHEN COUNT(*)=COUNT(actual_cost_usd) THEN SUM(actual_cost_usd) ELSE NULL END AS billedUsd FROM counted_rows GROUP BY date,provider,model,rolloutId,isLocal;`;
            const rows = await readJson(exec, 'sqlite3', ['-readonly', '-json', '-cmd', '.timeout 200', db, sql], {
                lane: 'usage_hermes', timeoutMs: 5000, key: 'usage:hermes', maxOutputBytes: 10 * 1024 * 1024
            }, { emptyArray: true });
            if (!Array.isArray(rows))
                throw unavailable('invalid_usage');
            const unknownTokenRows = rows.reduce((sum,row)=>sum+Number(row.unknownTokenRows || 0),0);
            const grouped=new Map(),sessions=[];
            for(const row of rows){
                const isLocal = row.isLocal === true || row.isLocal === 1 ? true : row.isLocal === false || row.isLocal === 0 ? false : null;
                const item={date:row.date,model:`${row.provider}/${row.model}`,inputTokens:row.inputTokens,outputTokens:row.outputTokens,cacheReadTokens:row.cacheReadTokens,cacheWriteTokens:row.cacheWriteTokens,billedUsd:row.billedUsd,isLocal};
                if(typeof row.rolloutId==='string'&&row.rolloutId)sessions.push({sessionId:hash(row.rolloutId),...item});
                const key=JSON.stringify([item.date,item.model]),existing=grouped.get(key);
                if(!existing)grouped.set(key,{...item});else{for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'])existing[k]+=item[k];existing.billedUsd=existing.billedUsd===null||item.billedUsd===null?null:existing.billedUsd+item.billedUsd;existing.isLocal=existing.isLocal===item.isLocal?item.isLocal:null;}
            }
            return {
                days:[...grouped.values()],sessions, observedAt, coverage: unknownTokenRows ? 'partial' : 'complete', note: `${unknownTokenRows} rows have unknown token counts. All recorded models; session totals attributed to start day. Reasoning is part of output. Only actual_cost_usd is billed spend.`
            };
        }
    };
}
module.exports = { createProvider: createHermesProvider, createHermesProvider, hermesDbPath };
