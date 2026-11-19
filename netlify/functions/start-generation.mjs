
const MODEL_ID = "fal-ai/vidu/q4/image-to-video";
const MAX_IMAGE_DATA_LENGTH = 5_000_000;
const ALLOWED_DURATIONS = new Set([5, 8, 10]);
const ALLOWED_RESOLUTIONS = new Set(["540p", "720p"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Разрешён только POST-запрос" }, 405);
  }

  const falKey = process.env.FAL_KEY;
  const expectedAccessCode = process.env.TRENDVIDEO_ACCESS_CODE;

  if (!falKey || !expectedAccessCode) {
    return json({ error: "Сервер не настроен: проверьте переменные окружения" }, 503);
  }

  try {
    const body = await request.json();

    const {
      imageData,
      prompt = "",
      duration = 5,
      resolution = "720p",
      accessCode,
    } = body;

    if (accessCode !== expectedAccessCode) {
      return json({ error: "Неверный защитный код" }, 403);
    }

    if (
      typeof imageData !== "string" ||
      imageData.length > MAX_IMAGE_DATA_LENGTH ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData)
    ) {
      return json({ error: "Фото отсутствует или имеет неподдерживаемый формат" }, 400);
    }

    if (typeof prompt !== "string" || prompt.length > 5000) {
      return json({ error: "Некорректное описание видео" }, 400);
    }

    if (!ALLOWED_DURATIONS.has(Number(duration))) {
      return json({ error: "Недопустимая длительность видео" }, 400);
    }

    if (!ALLOWED_RESOLUTIONS.has(resolution)) {
      return json({ error: "Недопустимое качество видео" }, 400);
    }

    const response = await fetch(
      `https://queue.fal.run/${MODEL_ID}`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${falKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: imageData,
          prompt,
          duration: Number(duration),
          resolution,
          enable_safety_checker: true,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("fal.ai error:", result);
      return json(
        { error: result.detail || result.message || "Ошибка отправки запроса в fal.ai" },
        response.status
      );
    }

    if (!result.request_id) {
      return json({ error: "Сервис не вернул номер запроса" }, 502);
    }

    return json({
      success: true,
      requestId: result.request_id,
    });

  } catch (error) {
    console.error("Generation error:", error);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
};
