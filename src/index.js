const MODEL_ID = "fal-ai/vidu/q4/image-to-video";
const MAX_IMAGE_DATA_LENGTH = 5000000;
const ALLOWED_DURATIONS = new Set([5, 8, 10]);
const ALLOWED_RESOLUTIONS = new Set(["540p", "720p"]);

const PRICES = {
  standard: {
    "5-540p": 189, "5-720p": 209,
    "8-540p": 209, "8-720p": 239,
    "10-540p": 239, "10-720p": 259
  },
  custom: {
    "5-540p": 189, "5-720p": 209,
    "8-540p": 209, "8-720p": 239,
    "10-540p": 239, "10-720p": 259
  },
  animate: {
    "5-540p": 49, "5-720p": 69,
    "8-540p": 79, "8-720p": 89,
    "10-540p": 89, "10-720p": 109
  }
};

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function errorMessage(data) {
  return data?.detail || data?.message || data?.error || "Ошибка fal.ai";
}

async function createOrder(request, env) {
    const origin = request.headers.get("Origin");

if (origin !== "https://trendvideo-ai.trendvideo-ai.workers.dev") {
  return json({ error: "Запрос с этого сайта запрещён." }, 403);
}
  if (request.method !== "POST") {
    return json({ error: "Метод не поддерживается." }, 405);
  }

  if (!env.DB) {
    return json({ error: "База данных не подключена." }, 503);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Некорректный JSON." }, 400);
  }

  const email =
    typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json({ error: "Укажите корректный email." }, 400);
  }

  const mode = body.mode;
  const duration = Number(body.duration);
  const resolution = body.resolution;

  if (!Object.hasOwn(PRICES, mode)) {
    return json({ error: "Неизвестный режим видео." }, 400);
  }

  if (!ALLOWED_DURATIONS.has(duration)) {
    return json({ error: "Недопустимая длительность." }, 400);
  }

  if (!ALLOWED_RESOLUTIONS.has(resolution)) {
    return json({ error: "Недопустимое качество." }, 400);
  }

  const priceRubles = PRICES[mode][`${duration}-${resolution}`];

  if (!priceRubles) {
    return json({ error: "Не удалось рассчитать стоимость." }, 400);
  }

  const prompt =
    typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";

  if (prompt.length > 5000) {
    return json({ error: "Описание слишком длинное." }, 400);
  }

  const orderId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const amountKopecks = priceRubles * 100;

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id) VALUES (?)"
      ).bind(userId),

      env.DB.prepare(`
        INSERT INTO orders (
          id,
          user_id,
          amount_kopecks,
          status,
          email,
          video_mode,
          duration,
          resolution,
          prompt
        )
        VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)
      `).bind(
        orderId,
        userId,
        amountKopecks,
        email,
        mode,
        duration,
        resolution,
        prompt
      )
    ]);

    return json({
      orderId,
      amountKopecks,
      amountRubles: priceRubles,
      status: "created"
    }, 201);

  } catch {
    return json({
      error: "Не удалось создать заказ. Попробуйте позже."
    }, 500);
  }
}

async function moderateContent(env, prompt, imageData) {
  const response = await fetch(
    "https://api.openai.com/v1/moderations",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: imageData }
          }
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error("Не удалось проверить содержимое.");
  }

  const data = await response.json();

  if (!data.results || !data.results[0]) {
    throw new Error("Нет результата проверки.");
  }

  return data.results[0].flagged === true;
}

async function handleRequest(request, env, path) {
  if (request.method !== "POST") {
    return json({ error: "Метод не поддерживается." }, 405);
  }

  if (!env.FAL_KEY || !env.TRENDVIDEO_ACCESS_CODE) {
    return json({
      error: "Сервер ещё не настроен. Проверь секреты."
    }, 503);
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

      if (!env.OPENAI_API_KEY) {
        return json({
          error: "Проверка безопасности не настроена."
        }, 503);
      }

      const isBlocked = await moderateContent(
        env,
        prompt.trim(),
        imageData
      );

      if (isBlocked) {
        return json({
          error: "Фотография или описание нарушают правила безопасности. Попробуйте другое изображение или описание."
        }, 400);
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
        return json({
          error: "fal.ai не вернул номер задания."
        }, 502);
      }

      return json({ requestId });
    }

    if (path === "/api/generation-status") {
      const { requestId } = body;

      if (
        typeof requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(requestId)
      ) {
        return json({
          error: "Некорректный номер задания."
        }, 400);
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

        return json({ status: "COMPLETED", videoUrl });
      }

      return json({
        status: "FAILED",
        error: "Неизвестный статус задания."
      });
    }

    return json({ error: "Маршрут не найден." }, 404);

  } catch {
    return json({
      error: "Ошибка соединения с fal.ai."
    }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

if (url.pathname === "/api/health") {
  try {
    await env.DB.prepare("SELECT 1").first();

    return json({
      ok: true,
      service: "trendvideo-ai",
      database: "connected"
    });
  } catch {
    return json({
      ok: false,
      service: "trendvideo-ai",
      database: "error"
    }, 503);
  }
}

    if (url.pathname === "/api/create-order") {
      return createOrder(request, env);
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
