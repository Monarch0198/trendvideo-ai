import { timingSafeEqual } from 'node:crypto';

const MODEL_ID = 'fal-ai/vidu/q4/image-to-video';
const MAX_IMAGE_DATA_LENGTH = 5_000_000;
const ALLOWED_DURATIONS = new Set([5, 8, 10]);
const ALLOWED_RESOLUTIONS = new Set(['540p', '720p']);

// Best-effort per-instance protection. The access code is the primary beta gate.
const recentStarts = new Map();

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
  if (!falKey) return json({ error: 'На сервере Netlify не найден FAL_KEY. Проверь переменную и заново опубликуй сайт.' }, 503);
  if (!accessSecret) return json({ error: 'Генерация пока закрыта: в Netlify нужно добавить защитный код TRENDVIDEO_ACCESS_CODE.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Не удалось прочитать данные запроса.' }, 400); }

  if (!safeEqual(body.accessCode || '', accessSecret)) return json({ error: 'Неверный защитный код.' }, 403);

  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  const previous = recentStarts.get(ip) || [];
  const recent = previous.filter((time) => now - time < 10 * 60 * 1000);
  if (recent.length >= 2) return json({ error: 'С этого подключения уже запущено 2 задания за последние 10 минут. Подожди немного.' }, 429);

  const imageData = body.imageData;
  if (typeof imageData !== 'string' || imageData.length > MAX_IMAGE_DATA_LENGTH || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData)) {
    return json({ error: 'Фото не подходит или слишком большое. Выбери JPG, PNG или WEBP.' }, 400);
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const duration = Number(body.duration);
  const resolution = body.resolution;
  if (!prompt || prompt.length > 1500) return json({ error: 'Описание видео должно содержать от 1 до 1500 символов.' }, 400);
  if (!ALLOWED_DURATIONS.has(duration)) return json({ error: 'Выбери длительность 5, 8 или 10 секунд.' }, 400);
  if (!ALLOWED_RESOLUTIONS.has(resolution)) return json({ error: 'Выбери качество 540p или 720p.' }, 400);

  try {
   const response = await fetch(`https://queue.fal.run/${MODEL_ID}`, { `, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        image_url: imageData,
        duration,
        resolution,
        enable_safety_checker: true
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('fal.ai submit error:', response.status, JSON.stringify(data).slice(0, 1500));
      return json({ error: data.detail || data.message || `fal.ai отклонил запрос (код ${response.status}).` }, 502);
    }
    if (!data.request_id) return json({ error: 'fal.ai не вернул номер задания.' }, 502);

    recent.push(now);
    recentStarts.set(ip, recent);
    return json({ requestId: data.request_id, status: data.status || 'IN_QUEUE' });
  } catch (error) {
    console.error('fal.ai connection error:', error);
    return json({ error: 'Не удалось связаться с fal.ai. Попробуй позже.' }, 502);
  }
};
