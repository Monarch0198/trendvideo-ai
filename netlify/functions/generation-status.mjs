
import { timingSafeEqual } from "node:crypto";

const MODEL_ID = "fal-ai/vidu/q4/image-to-video";

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
  const accessSecret = process.env.TRENDVIDEO_ACCESS_CODE;

  if (!falKey || !accessSecret) {
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

    if (!safeEqual(body.accessCode, accessSecret)) {
      return json({ error: "Неверный защитный код." }, 403);
    }

    const requestId = String(body.requestId || "");

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    ) {
      return json({ error: "Некорректный номер задания." }, 400);
    }

    const headers = {
      Authorization: `Key ${falKey}`,
    };

    const base = `https://queue.fal.run/${MODEL_ID}/requests/${requestId}`;

    const statusResponse = await fetch(`${base}/status`, { headers });

    const statusData = await statusResponse.json().catch(() => ({}));

    if (!statusResponse.ok) {
      console.error("fal.ai status error:", statusData);

      return json({
        error: "Не удалось проверить состояние задания. Попробуйте позже.",
      }, 502);
    }

    const currentStatus = statusData.status;

    if (currentStatus === "IN_QUEUE") {
      return json({
        status: "IN_QUEUE",
        queuePosition: statusData.queue_position ?? null,
      });
    }

    if (currentStatus === "IN_PROGRESS") {
      return json({
        status: "IN_PROGRESS",
      });
    }

    if (currentStatus === "FAILED") {
      return json({
        status: "FAILED",
        error: "Сервис генерации не смог создать видео.",
      });
    }

    if (currentStatus !== "COMPLETED") {
      console.error("Unknown fal.ai status:", currentStatus);

      return json({
        status: "FAILED",
        error: "Сервис вернул неизвестный статус задания.",
      });
    }

    const resultResponse = await fetch(base, { headers });

    const resultData = await resultResponse.json().catch(() => ({}));

    if (!resultResponse.ok || resultData.error || !resultData.video?.url) {
      console.error("fal.ai result error:", resultData);

      return json({
        status: "FAILED",
        error: "Видео не удалось получить. Возможно, запрос был отклонён проверкой безопасности.",
      });
    }

    return json({
      status: "COMPLETED",
      videoUrl: resultData.video.url,
    });

  } catch (error) {
    console.error("Generation status server error:", error);

    return json({
      error: "Не удалось получить статус генерации. Попробуйте позже.",
    }, 502);
  }
};
