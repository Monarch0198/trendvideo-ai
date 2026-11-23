
const MODEL_ID = "fal-ai/vidu/q4/image-to-video";
const MAX_IMAGE_DATA_LENGTH = 5000000;
const ALLOWED_DURATIONS = new Set([5, 8, 10]);
const ALLOWED_RESOLUTIONS = new Set(["540p", "720p"]);

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function errorMessage(data) {
  return data?.detail || data?.message || data?.error || "Ошибка fal.ai";
}

async function handleRequest(request, env, path) {
  if (request.method !== "POST") {
    return json({ error: "Метод не поддерживается." }, 405);
  }

  if (!env.FAL_KEY || !env.TRENDVIDEO_ACCESS_CODE) {
    return json({ error: "Сервер ещё не настроен. Проверь секреты." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Некорректный JSON." }, 400);
  }

  if (body.accessCode !== env.TRENDVIDEO_ACCESS_CODE) {
    return json({ error: "Неверный защитный код." }, 403);
  }

  const headers = {
    Authorization: `Key ${env.FAL_KEY}`,
    "Content-Type": "application/json"
  };

  try {
    if (path === "/api/start-generation") {
      const { imageData, prompt, duration, resolution } = body;

      if (
        typeof imageData !== "string" ||
        imageData.length > MAX_IMAGE_DATA_LENGTH ||
        !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData)
      ) {
        return json({ error: "Некорректная фотография." }, 400);
      }

      if (
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.length > 5000
      ) {
        return json({ error: "Проверь описание видео." }, 400);
      }

      if (!ALLOWED_DURATIONS.has(Number(duration))) {
        return json({ error: "Недопустимая длительность." }, 400);
      }

      if (!ALLOWED_RESOLUTIONS.has(resolution)) {
        return json({ error: "Недопустимое качество." }, 400);
      }

      const response = await fetch(
        `https://queue.fal.run/${MODEL_ID}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            image_url: imageData,
            prompt: prompt.trim(),
            duration: Number(duration),
            resolution,
            enable_safety_checker: true
          })
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return json({ error: errorMessage(data) }, response.status);
      }

      const requestId = data.request_id || data.requestId;

      if (!requestId) {
        return json({ error: "fal.ai не вернул номер задания." }, 502);
      }

      return json({ requestId });
    }

    if (path === "/api/generation-status") {
      const { requestId } = body;

      if (
        typeof requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(requestId)
      ) {
        return json({ error: "Некорректный номер задания." }, 400);
      }

      const baseUrl =
        `https://queue.fal.run/${MODEL_ID}/requests/${requestId}`;

      const statusResponse = await fetch(`${baseUrl}/status`, {
        headers
      });

      const statusData = await statusResponse.json().catch(() => ({}));

      if (!statusResponse.ok) {
        return json({ error: errorMessage(statusData) }, 502);
      }

      if (statusData.status === "IN_QUEUE") {
        return json({
          status: "IN_QUEUE",
          queuePosition: statusData.queue_position ?? null
        });
      }

      if (statusData.status === "IN_PROGRESS") {
        return json({ status: "IN_PROGRESS" });
      }

      if (statusData.status === "FAILED") {
        return json({
          status: "FAILED",
          error: statusData.error || "Не удалось создать видео."
        });
      }

      if (statusData.status === "COMPLETED") {
        const resultResponse = await fetch(baseUrl, { headers });
        const resultData = await resultResponse.json().catch(() => ({}));

        if (!resultResponse.ok) {
          return json({ error: errorMessage(resultData) }, 502);
        }

        const videoUrl = resultData.video?.url;

        if (!videoUrl) {
          return json({
            status: "FAILED",
            error: "fal.ai не вернул ссылку на видео."
          });
        }

        return json({
          status: "COMPLETED",
          videoUrl
        });
      }

      return json({
        status: "FAILED",
        error: "Неизвестный статус задания."
      });
    }

    return json({ error: "Маршрут не найден." }, 404);

  } catch {
    return json({ error: "Ошибка соединения с fal.ai." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "trendvideo-ai"
      });
    }

    if (
      url.pathname === "/api/start-generation" ||
      url.pathname === "/api/generation-status"
    ) {
      return handleRequest(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  }
};
