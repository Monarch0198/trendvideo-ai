import { timingSafeEqual } from 'node:crypto';

const MODEL_ID = 'fal-ai/vidu/q4/image-to-video';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'Используй POST-запрос.' }, 405);
  const falKey = process.env.FAL_KEY;
  const accessSecret = process.env.TRENDVIDEO_ACCESS_CODE;
  if (!falKey || !accessSecret) return json({ error: 'Сервер пока не настроен. Проверь FAL_KEY и TRENDVIDEO_ACCESS_CODE в Netlify.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Не удалось прочитать запрос.' }, 400); }
  if (!safeEqual(body.accessCode || '', accessSecret)) return json({ error: 'Неверный защитный код.' }, 403);

  const requestId = String(body.requestId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return json({ error: 'Некорректный номер задания.' }, 400);
  }

  const headers = { 'Authorization': `Key ${falKey}` };
  const base = `https://queue.fal.run/${MODEL_ID}/requests/${requestId}`;

  try {
    const statusResponse = await fetch(`${base}/status`, { headers });
    const statusData = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) {
      return json({ error: statusData.detail || `Не удалось проверить статус (код ${statusResponse.status}).` }, 502);
    }

    if (statusData.status !== 'COMPLETED') {
      return json({ status: statusData.status || 'IN_PROGRESS', queuePosition: statusData.queue_position ?? null });
    }

    const resultResponse = await fetch(base, { headers });
    const resultData = await resultResponse.json().catch(() => ({}));
    if (!resultResponse.ok || resultData.error || !resultData.video?.url) {
      const message = resultData.detail || resultData.error || 'Модель завершила запрос без видео. Возможно, запрос был отклонён проверкой безопасности.';
      return json({ status: 'FAILED', error: message }, 200);
    }

    return json({ status: 'COMPLETED', videoUrl: resultData.video.url });
  } catch (error) {
    console.error('fal.ai status error:', error);
    return json({ error: 'Не удалось получить статус из fal.ai.' }, 502);
  }
};
