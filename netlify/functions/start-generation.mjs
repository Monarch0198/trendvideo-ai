
import { timingSafeEqual } from "node:crypto";

const MODEL_ID = "fal-ai/vidu/q4/image-to-video";
const MAX_IMAGE_DATA_LENGTH = 5_000_000;

const ALLOWED_DURATIONS = new Set([5, 8, 10]);
const ALLOWED_RESOLUTIONS = new Set(["540p", "720p"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));

  return (
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function getErrorText(value) {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map(getErrorText).join(" ");
  }

  if (value && typeof value === "object") {
    return [
      value.message,
      value.detail,
      value.error,
    ].filter(Boolean).map(getErrorText).join(" ");
  }

  return "";
}

function isBalanceError(value) {
  return /exhausted balance|insufficient balance|not enough credits|out of credits/i
    .test(getErrorText(value));
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Разрешён только POST-запрос." }, 405);
  }

  const falKey = process.env.FAL_KEY;
  const expectedAccessCode = process.env.TRENDVIDEO_ACCESS_CODE;

  if (!falKey || !expectedAccessCode) {
    return json({
      error: "Сервер пока не настроен. Проверьте настройки Netlify.",
    }, 503);
  }

  try {
    let body;

    try {
      body = await request.json();
    } catch {
      return json({ error: "Не удалось прочитать запрос." }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Некорректные данные запроса." }, 400);
    }

    const {
      imageData,
      prompt = "",
      duration = 5,
      resolution = "720p",
      accessCode,
    } = body;

    if (!safeEqual(accessCode, expectedAccessCode)) {
      return json({ error: "Неверный защитный код." }, 403);
    }

    if (
      typeof imageData !== "string" ||
      imageData.length > MAX_IMAGE_DATA_LENGTH ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData)
    ) {
      return json({
        error: "Фото отсутствует, слишком большое или имеет неподдерживаемый формат.",
      }, 400);
    }

    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > 5000) {
      return json({ error: "Добавьте корректное описание видео." }, 400);
    }

    const videoDuration = Number(duration);

    if (!ALLOWED_DURATIONS.has(videoDuration)) {
      return json({ error: "Недопустимая длительность видео." }, 400);
    }

    if (!ALLOWED_RESOLUTIONS.has(resolution)) {
      return json({ error: "Недопустимое качество видео." }, 400);
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
          prompt: prompt.trim(),
          duration: videoDuration,
          resolution,
          enable_safety_checker: true,
        }),
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("fal.ai request error:", result);

      if (isBalanceError(result)) {
        return json({
          error: "На балансе сервиса генерации недостаточно средств. Видео пока создать нельзя.",
          errorCode: "INSUFFICIENT_BALANCE",
        }, 402);
      }

      return json({
        error: "Сервис генерации временно не принял запрос. Попробуйте позже.",
        errorCode: "GENERATION_REQUEST_FAILED",
      }, 502);
    }

    if (
      typeof result.request_id !== "string" ||
      !result.request_id
    ) {
      console.error("fal.ai response without request_id:", result);

      return json({
        error: "Сервис не вернул номер задания. Попробуйте позже.",
      }, 502);
    }

    return json({
      success: true,
      requestId: result.request_id,
    });

  } catch (error) {
    console.error("Generation server error:", error);

    return json({
      error: "Внутренняя ошибка сервера. Попробуйте позже.",
    }, 500);
  }
};
