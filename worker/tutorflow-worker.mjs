const PROJECT_ID = "turtorflow";

const C = {
  green: "#176B53",
  deep: "#155542",
  mint: "#EAF4ED",
  cream: "#FFFCF8",
  white: "#FFFFFF",
  dark: "#273B45",
  muted: "#687889",
  line: "#E5ECE7"
};

const MAX_DAYS = 12;
const MAX_TIMES_PER_DAY = 4;
const BINDING_TTL = 600;

const PRICES = {
  junior: {
    title: "國中",
    subtitle: "數學・自然",
    onsite: [700, 650],
    online: [600, 500]
  },
  elementary: {
    title: "國小",
    subtitle: "全科輔導",
    onsite: [600, 550],
    online: [500, 400]
  }
};

// ========================================
// Worker 入口
// ========================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/admin/monthly") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {status: 405, headers: {Allow: "GET"}});
      }
      return monthlyAdminPage();
    }

    if (url.pathname === "/admin/monthly-students" || url.pathname === "/admin/monthly-preview") {
      return handleMonthlyAdmin(request, env, url.pathname);
    }

    if (url.pathname === "/admin/student-lookup") {
      return handleStudentLookup(request, env);
    }

    if (url.pathname === "/admin/richmenu") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }
      return adminPage();
    }

    if (url.pathname === "/admin/richmenu/install") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }
      return installRichMenu(request, env);
    }

    const iconMatch = url.pathname.match(
      /^\/icons\/(teacher|price|calendar|policy|home|laptop|binding)\.png$/
    );

    if (iconMatch) {
      return new Response(iconPNG(iconMatch[1]), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400"
        }
      });
    }

    if (request.method === "GET") {
      return new Response("TutorFlow is online");
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405
      });
    }

    if (
      !env.LINE_CHANNEL_SECRET ||
      !env.LINE_CHANNEL_ACCESS_TOKEN
    ) {
      return new Response("Missing LINE secrets", {
        status: 500
      });
    }

    const body = await request.text();

    const verified = await validSignature(
      body,
      request.headers.get("x-line-signature"),
      env.LINE_CHANNEL_SECRET
    );

    if (!verified) {
      return new Response("Forbidden", {
        status: 403
      });
    }

    let payload;

    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", {
        status: 400
      });
    }

    const base = (
      env.ICON_BASE_URL || url.origin
    ).replace(/\/+$/, "");

    ctx.waitUntil(
      processEvents(payload.events || [], env, base)
    );

    return new Response("OK");
  }
};

// ========================================
// Webhook 事件處理
// ========================================

async function processEvents(events, env, base) {
  for (const event of events) {
    try {
      await handleEvent(event, env, base);
    } catch (error) {
      console.error(
        "Event processing failed:",
        error?.name || "Error"
      );
    }
  }
}

async function validSignature(body, signature, secret) {
  if (!signature) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(
        atob(signature),
        c => c.charCodeAt(0)
      ),
      new TextEncoder().encode(body)
    );
  } catch {
    return false;
  }
}

async function handleEvent(event, env, base) {
  if (!event.replyToken) return;

  if (event.mode === "standby") return;

  if (event.type === "postback") {
    const data = event.postback?.data || "";

    switch (data) {
      case "menu_open":
        await reply(
          env,
          event.replyToken,
          menuMessage(base)
        );
        return;

      case "menu_experience":
        await reply(
          env,
          event.replyToken,
          experienceFlex(base)
        );
        return;

      case "menu_price":
        await reply(
          env,
          event.replyToken,
          priceFlex(base)
        );
        return;

      case "menu_availability":
        await handleAvailability(
          event,
          env,
          base
        );
        return;

      case "menu_policy":
        await reply(
          env,
          event.replyToken,
          policyFlex(base)
        );
        return;

      case "bind_monthly_student":
        await startMonthlyBinding(
          event,
          env,
          base
        );
        return;

      case "cancel_monthly_binding":
        await cancelMonthlyBinding(
          event,
          env,
          base
        );
        return;

      default:
        return;
    }
  }

  if (
    event.type === "message" &&
    event.message?.type === "text"
  ) {
    const handled = await handleBindingText(
      event,
      env,
      base
    );

    if (handled) return;

    const text = event.message.text.trim();

    if (
      text === "選單" ||
      text === "查看選單"
    ) {
      await reply(
        env,
        event.replyToken,
        menuMessage(base)
      );
    }

    // 其他一般文字不自動回覆。
    // 保留給老師真人處理。
  }
}

// ========================================
// LINE Reply API
// ========================================

async function reply(env, replyToken, messages) {
  const list = Array.isArray(messages)
    ? messages
    : [messages];

  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        Authorization:
          "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        replyToken,
        messages: list
      })
    }
  );

  if (!response.ok) {
    console.error(
      "LINE Reply API failed:",
      response.status
    );

    throw new Error("LINE reply failed");
  }
}

// ========================================
// LINE Push API
// 預留給未來月結 Flex
// ========================================

async function pushMessage(env, userId, messages) {
  const list = Array.isArray(messages)
    ? messages
    : [messages];

  const response = await fetch(
    "https://api.line.me/v2/bot/message/push",
    {
      method: "POST",
      headers: {
        Authorization:
          "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        to: userId,
        messages: list
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      "LINE Push API failed: " + response.status
    );
  }
}

// ========================================
// Quick Reply 五顆按鈕
// ========================================

function quickReply(base) {
  const buttons = [
    [
      "教學經驗",
      "menu_experience",
      "teacher"
    ],
    [
      "課程費用",
      "menu_price",
      "price"
    ],
    [
      "詢問時段",
      "menu_availability",
      "calendar"
    ],
    [
      "上課須知",
      "menu_policy",
      "policy"
    ],
    [
      "月結綁定",
      "bind_monthly_student",
      "binding"
    ]
  ];

  return {
    items: buttons.map(
      ([label, data, name]) => ({
        type: "action",

        imageUrl:
          `${base}/icons/${name}.png`,

        action: {
          type: "postback",
          label,
          data
        }
      })
    )
  };
}

function menuMessage(base) {
  return {
    type: "text",
    text: "您好！請選擇您想查看的資訊。",
    quickReply: quickReply(base)
  };
}

function textMessage(text, base) {
  return {
    type: "text",
    text,
    quickReply: quickReply(base)
  };
}

function bindingInputMessage(text) {
  return {
    type: "text",
    text,

    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "取消操作",
            data: "cancel_monthly_binding"
          }
        }
      ]
    }
  };
}

// ========================================
// Flex Message 共用元件
// ========================================

function t(text, options = {}) {
  return {
    type: "text",
    text: String(text),
    size: "sm",
    color: C.dark,
    wrap: true,
    ...options
  };
}

function b(contents, options = {}) {
  return {
    type: "box",
    layout: "vertical",
    contents,
    ...options
  };
}

function r(contents, options = {}) {
  return {
    type: "box",
    layout: "horizontal",
    alignItems: "center",
    contents,
    ...options
  };
}

function sep(margin = "md") {
  return {
    type: "separator",
    color: C.line,
    margin
  };
}

function icon(base, name, size = "32px") {
  return {
    type: "image",
    url: `${base}/icons/${name}.png`,
    size,
    aspectRatio: "1:1",
    aspectMode: "fit",
    flex: 0
  };
}

function heading(base, name, title, subtitle) {
  return r(
    [
      icon(base, name),

      b(
        [
          t(title, {
            weight: "bold",
            size: "xl",
            color: C.deep
          }),

          t(subtitle, {
            size: "xs",
            color: C.muted
          })
        ],
        {
          spacing: "xs"
        }
      )
    ],
    {
      spacing: "md"
    }
  );
}

function sectionTitle(title) {
  return t(title, {
    color: C.green,
    weight: "bold",
    size: "md"
  });
}

function bubble(contents) {
  return {
    type: "bubble",
    size: "mega",
    body: b(contents, {
      paddingAll: "20px",
      spacing: "lg",
      backgroundColor: C.cream
    })
  };
}

function flexMessage(altText, contents, base) {
  return {
    type: "flex",
    altText,
    contents,
    quickReply: quickReply(base)
  };
}

function money(amount) {
  return "NT$" +
    Number(amount).toLocaleString("en-US");
}

// ========================================
// 教學經驗
// ========================================

function experienceFlex(base) {
  const content = bubble([
    heading(
      base,
      "teacher",
      "教學經驗",
      "TEACHING EXPERIENCE"
    ),

    sep(),

    sectionTitle("關於老師"),

    t(
      "提供國小及國中一對一家教，依照學生程度、學習需求及個別狀況安排課程。"
    ),

    sectionTitle("教學成果"),

    resultCard(
      "國中數學",
      "20 分 → 70 分"
    ),

    resultCard(
      "國中自然",
      "50 分 → 94 分"
    ),

    resultCard(
      "國小數學",
      "不及格 → 80 分"
    ),

    resultCard(
      "國小全科",
      "班級前六名"
    ),

    sep(),

    t(
      "歡迎與老師討論學生目前的學習狀況及課程需求。",
      {
        color: C.muted,
        size: "xs"
      }
    )
  ]);

  return flexMessage(
    "教學經驗與教學成果",
    content,
    base
  );
}

function resultCard(subject, result) {
  return b(
    [
      t(subject, {
        size: "xs",
        color: C.muted
      }),

      t(result, {
        color: C.green,
        weight: "bold",
        size: "xl"
      })
    ],
    {
      backgroundColor: C.mint,
      cornerRadius: "12px",
      paddingAll: "14px",
      spacing: "sm"
    }
  );
}

// ========================================
// 課程費用
// ========================================

function priceFlex(base) {
  return flexMessage(
    "課程費用與收費方案",

    {
      type: "carousel",

      contents: [
        priceBubble(
          base,
          PRICES.junior
        ),

        priceBubble(
          base,
          PRICES.elementary
        )
      ]
    },

    base
  );
}

function priceBubble(base, plan) {
  return bubble([
    heading(
      base,
      "price",
      plan.title + "課程費用",
      plan.subtitle
    ),

    sep(),

    priceSection(
      base,
      "home",
      "到府教學",
      plan.onsite
    ),

    sep(),

    priceSection(
      base,
      "laptop",
      "線上教學",
      plan.online
    ),

    b(
      [
        sectionTitle("收費說明"),

        t(
          "單堂：依當次上課時數計算，下課後支付。"
        ),

        t(
          "月收：依當月確認課程時數計算，於月初支付。"
        ),

        t(
          "實際費用依雙方確認的課程安排為準。",
          {
            size: "xs",
            color: C.muted
          }
        )
      ],
      {
        spacing: "sm",
        paddingAll: "12px",
        cornerRadius: "12px",
        backgroundColor: C.mint
      }
    )
  ]);
}

function priceSection(base, name, title, prices) {
  return b(
    [
      r(
        [
          icon(base, name, "26px"),
          sectionTitle(title)
        ],
        {
          spacing: "sm"
        }
      ),

      r([
        t("單堂時薪", {
          color: C.muted
        }),

        t(money(prices[0]), {
          align: "end",
          weight: "bold",
          size: "lg"
        })
      ]),

      r([
        t("月收時薪", {
          color: C.muted
        }),

        t(money(prices[1]), {
          align: "end",
          weight: "bold",
          color: C.green,
          size: "lg"
        })
      ])
    ],
    {
      spacing: "md"
    }
  );
}

// ========================================
// 上課須知
// ========================================

function policyFlex(base) {
  return flexMessage(
    "上課須知",

    bubble([
      heading(
        base,
        "policy",
        "上課須知",
        "CLASS POLICY"
      ),

      sep(),

      sectionTitle("請假與課程異動"),

      t(
        "若需請假或調整上課時間，請至少提前 24 小時通知老師。"
      ),

      t(
        "補課時間須由雙方共同確認，依老師可安排的時段進行。"
      ),

      sep(),

      sectionTitle("遲到與缺席"),

      t(
        "如遇遲到或缺席，請主動聯繫老師，相關課程費用依雙方約定的教學合作規範辦理。"
      ),

      sep(),

      sectionTitle("課程費用"),

      t(
        "單堂課程於下課後支付；月收課程依當月確認時數，於月初支付。"
      ),

      b(
        [
          t(
            "如有特殊狀況，歡迎提前與老師討論。",
            {
              size: "xs",
              color: C.green
            }
          )
        ],
        {
          backgroundColor: C.mint,
          paddingAll: "12px",
          cornerRadius: "10px"
        }
      )
    ]),

    base
  );
}

// ========================================
// Firebase 公開空堂
// ========================================

function firestoreBase(env) {
  const projectId =
    env.FIREBASE_PROJECT_ID || PROJECT_ID;

  return (
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/" + encodeURIComponent(env.FIRESTORE_DATABASE_ID || "(default)") +
    "/documents"
  );
}

function teacherUid(env) {
  const uid = env.TUTORFLOW_TEACHER_UID || env.TEACHER_UID;

  if (
    !uid ||
    !/^[A-Za-z0-9_-]{5,128}$/.test(uid)
  ) {
    throw new Error(
      "Missing or invalid teacher UID"
    );
  }

  return uid;
}

function decodeFirestoreValue(value) {
  if (!value) return null;

  if ("stringValue" in value) {
    return value.stringValue;
  }

  if ("integerValue" in value) {
    return Number(value.integerValue);
  }

  if ("doubleValue" in value) {
    return value.doubleValue;
  }

  if ("booleanValue" in value) {
    return value.booleanValue;
  }

  if ("timestampValue" in value) {
    return value.timestampValue;
  }

  if ("nullValue" in value) {
    return null;
  }

  if ("arrayValue" in value) {
    return (
      value.arrayValue.values || []
    ).map(decodeFirestoreValue);
  }

  if ("mapValue" in value) {
    return decodeFirestoreFields(
      value.mapValue.fields || {}
    );
  }

  return null;
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(
      ([key, value]) => [
        key,
        decodeFirestoreValue(value)
      ]
    )
  );
}

async function fetchAvailability(env) {
  const uid = teacherUid(env);

  const url =
    firestoreBase(env) +
    "/teachers/" +
    encodeURIComponent(uid) +
    "/public/publicAvailability";

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      "Availability read failed: " +
      response.status
    );
  }

  const doc = await response.json();

  const data = decodeFirestoreFields(
    doc.fields || {}
  );

  if (!Array.isArray(data.slots)) {
    return [];
  }

  return data.slots;
}

function taipeiToday() {
  const parts =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

  const obj = Object.fromEntries(
    parts.map(part => [
      part.type,
      part.value
    ])
  );

  return `${obj.year}-${obj.month}-${obj.day}`;
}

function taipeiTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}

function addDays(date, days) {
  const value = new Date(
    date + "T00:00:00Z"
  );

  value.setUTCDate(
    value.getUTCDate() + days
  );

  return value.toISOString().slice(0, 10);
}

function formatDate(date) {
  const weekdays = [
    "日", "一", "二", "三",
    "四", "五", "六"
  ];

  const value = new Date(
    date + "T00:00:00Z"
  );

  return (
    date.slice(5).replace("-", "/") +
    "（" +
    weekdays[value.getUTCDay()] +
    "）"
  );
}

function normalizeSlots(slots) {
  const today = taipeiToday();
  const now = taipeiTime();

  const lastDate = addDays(
    today,
    MAX_DAYS - 1
  );

  const seen = new Set();

  return slots
    .filter(slot => {
      if (!slot || typeof slot !== "object") {
        return false;
      }

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          slot.date || ""
        )
      ) return false;

      if (
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(
          slot.start || ""
        )
      ) return false;

      if (
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(
          slot.end || ""
        )
      ) return false;

      if (
        slot.status &&
        slot.status !== "available"
      ) return false;

      if (slot.end <= slot.start) {
        return false;
      }

      if (
        slot.date < today ||
        slot.date > lastDate
      ) return false;

      if (
        slot.date === today &&
        slot.start <= now
      ) return false;

      const key =
        slot.date +
        "_" +
        slot.start +
        "_" +
        slot.end;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    })
    .sort((a, b) => {
      return (
        a.date.localeCompare(b.date) ||
        a.start.localeCompare(b.start)
      );
    });
}

async function handleAvailability(
  event,
  env,
  base
) {
  try {
    const raw = await fetchAvailability(env);

    const slots = normalizeSlots(raw);

    if (!slots.length) {
      await reply(
        env,
        event.replyToken,
        textMessage(
          "目前暫無可預約時段，歡迎直接與老師聯繫。",
          base
        )
      );

      return;
    }

    await reply(
      env,
      event.replyToken,
      availabilityFlex(
        slots,
        env,
        base
      )
    );

  } catch (error) {
    console.error(
      "Availability error:",
      error?.message
    );

    await reply(
      env,
      event.replyToken,
      textMessage(
        "目前無法取得最新空堂，請稍後再試，或直接與老師聯繫。",
        base
      )
    );
  }
}

function bookingUri(env, slot) {
  const oaId = env.LINE_OA_ID || "";

  const text = [
    "您好，我想詢問以下課程時段：",
    "",
    "日期：" + slot.date,
    "時間：" + slot.start + "–" + slot.end,
    "學生年級：",
    "欲加強科目：",
    "上課地點："
  ].join("\n");

  return (
    "https://line.me/R/oaMessage/" +
    encodeURIComponent(oaId) +
    "/?" +
    encodeURIComponent(text)
  );
}

function availabilityFlex(slots, env, base) {
  const days = new Map();

  for (const slot of slots) {
    if (!days.has(slot.date)) {
      days.set(slot.date, []);
    }

    days.get(slot.date).push(slot);
  }

  const cards = [];

  for (const [date, items] of days) {
    const rows = items
      .slice(0, MAX_TIMES_PER_DAY)
      .map(slot => {
        return b(
          [
            t(
              slot.start + " – " + slot.end,
              {
                color: C.deep,
                weight: "bold",
                align: "center"
              }
            )
          ],
          {
            backgroundColor: C.mint,
            paddingAll: "12px",
            cornerRadius: "10px",

            action: {
              type: "uri",
              label: "詢問此時段",
              uri: bookingUri(env, slot)
            }
          }
        );
      });

    cards.push(
      bubble([
        heading(
          base,
          "calendar",
          formatDate(date),
          "AVAILABLE TIME"
        ),

        sep(),

        ...rows,

        t(
          "點擊時段即可詢問老師，實際預約以老師確認為準。",
          {
            size: "xs",
            color: C.muted
          }
        )
      ])
    );
  }

  return flexMessage(
    "近期可預約課程時段",

    {
      type: "carousel",
      contents: cards.slice(0, 12)
    },

    base
  );
}

// ========================================
// 月結綁定
// ========================================

function bindingReady(env) {
  return Boolean(
    env.MONTHLY_BINDINGS &&
    env.TUTORFLOW_TEACHER_UID &&
    env.FIREBASE_SERVICE_ACCOUNT
  );
}

function stateKey(env, userId) {
  return (
    "monthly:state:" +
    teacherUid(env) +
    ":" +
    userId
  );
}

function parentKey(env, userId) {
  return (
    "monthly:parent:" +
    teacherUid(env) +
    ":" +
    userId
  );
}

function studentKey(env, studentId) {
  return (
    "monthly:student:" +
    teacherUid(env) +
    ":" +
    studentId
  );
}

function getUserId(event) {
  if (event.source?.type !== "user") {
    return null;
  }

  const id = event.source?.userId;

  return typeof id === "string"
    ? id
    : null;
}

async function startMonthlyBinding(
  event,
  env,
  base
) {
  const userId = getUserId(event);

  if (!userId) {
    await reply(
      env,
      event.replyToken,
      textMessage(
        "請在官方帳號的一對一聊天室使用月結綁定。",
        base
      )
    );

    return;
  }

  if (!bindingReady(env)) {
    await reply(
      env,
      event.replyToken,
      textMessage(
        "月結綁定功能目前尚未開放，請與老師聯繫。",
        base
      )
    );

    return;
  }

  const existing =
    await env.MONTHLY_BINDINGS.get(
      parentKey(env, userId),
      "json"
    );

  if (existing?.studentId) {
    await reply(
      env,
      event.replyToken,
      textMessage(
        "您已完成月結綁定，無須重複操作。如需更換綁定學生，請與老師聯繫。",
        base
      )
    );

    return;
  }

  await env.MONTHLY_BINDINGS.put(
    stateKey(env, userId),

    JSON.stringify({
      action: "awaiting_student_name",
      createdAt: Date.now(),
      attempts: 0
    }),

    {
      expirationTtl: BINDING_TTL
    }
  );

  await reply(
    env,
    event.replyToken,

    bindingInputMessage(
      "📋 月結課程綁定\n\n" +
      "此功能提供月結制學生家長使用，方便日後接收每月課程安排與費用通知。\n\n" +
      "請輸入學生姓名（兩個中文字）。"
    )
  );
}

async function cancelMonthlyBinding(
  event,
  env,
  base
) {
  const userId = getUserId(event);

  if (
    userId &&
    env.MONTHLY_BINDINGS &&
    env.TUTORFLOW_TEACHER_UID
  ) {
    await env.MONTHLY_BINDINGS.delete(
      stateKey(env, userId)
    );
  }

  await reply(
    env,
    event.replyToken,
    textMessage(
      "已取消本次綁定操作。",
      base
    )
  );
}

async function handleBindingText(
  event,
  env,
  base
) {
  if (!bindingReady(env)) {
    return false;
  }

  const userId = getUserId(event);

  if (!userId) {
    return false;
  }

  const key = stateKey(env, userId);

  const state =
    await env.MONTHLY_BINDINGS.get(
      key,
      "json"
    );

  if (
    !state ||
    state.action !== "awaiting_student_name"
  ) {
    return false;
  }

  const name =
    event.message.text.trim();

  if (
    name === "取消" ||
    name === "取消操作"
  ) {
    await cancelMonthlyBinding(
      event,
      env,
      base
    );

    return true;
  }

  if (
    Date.now() - state.createdAt >
    BINDING_TTL * 1000
  ) {
    await env.MONTHLY_BINDINGS.delete(key);

    await reply(
      env,
      event.replyToken,
      textMessage(
        "本次綁定操作已逾時，請重新點選月結綁定。",
        base
      )
    );

    return true;
  }

  if (!/^\p{Script=Han}{2}$/u.test(name)) {
    await reply(
      env,
      event.replyToken,

      bindingInputMessage(
        "請輸入兩個中文字的學生姓名，或點擊取消操作。"
      )
    );

    return true;
  }

  if (Number(state.attempts || 0) >= 5) {
    await env.MONTHLY_BINDINGS.delete(key);

    await reply(
      env,
      event.replyToken,
      textMessage(
        "查詢次數已達上限，請與老師聯繫。",
        base
      )
    );

    return true;
  }

  try {
    const matches =
      await findStudentsByExactName(
        env,
        name
      );

    if (matches.length === 0) {
      const remaining = Math.max(
        60,
        Math.ceil(
          (
            state.createdAt +
            BINDING_TTL * 1000 -
            Date.now()
          ) / 1000
        )
      );

      await env.MONTHLY_BINDINGS.put(
        key,

        JSON.stringify({
          ...state,
          attempts:
            Number(state.attempts || 0) + 1
        }),

        {
          expirationTtl: remaining
        }
      );

      await reply(
        env,
        event.replyToken,

        bindingInputMessage(
          "查無符合的學生資料，請確認姓名後重新輸入。"
        )
      );

      return true;
    }

    if (matches.length !== 1) {
      await env.MONTHLY_BINDINGS.delete(key);

      await reply(
        env,
        event.replyToken,

        textMessage(
          "目前無法確認學生資料，請與老師聯繫。",
          base
        )
      );

      return true;
    }

    const student = matches[0];

    const result =
      await saveStudentBinding(
        env,
        student.id,
        userId
      );

    await env.MONTHLY_BINDINGS.delete(key);

    if (result === "conflict") {
      await reply(
        env,
        event.replyToken,

        textMessage(
          "目前無法完成綁定，請與老師聯繫。",
          base
        )
      );

      return true;
    }

    if (result === "existing") {
      await reply(
        env,
        event.replyToken,

        textMessage(
          "您已完成月結綁定，無須重複操作。",
          base
        )
      );

      return true;
    }

    await reply(
      env,
      event.replyToken,

      textMessage(
        "✅ 月結綁定成功！\n\n" +
        "已成功建立學生資料關聯。\n\n" +
        "日後老師將透過此 LINE 官方帳號發送每月課程安排、確認通知及月結費用資訊。",
        base
      )
    );

    return true;

  } catch (error) {
    console.error(
      "Monthly binding failed:",
      error?.name || "Error"
    );

    await reply(
      env,
      event.replyToken,

      bindingInputMessage(
        "目前暫時無法完成綁定，請稍後再試。"
      )
    );

    return true;
  }
}

// ========================================
// 儲存學生與 LINE 帳號關聯
// ========================================

async function saveStudentBinding(
  env,
  studentId,
  userId
) {
  const pKey = parentKey(env, userId);
  const sKey = studentKey(env, studentId);

  const [parent, student] =
    await Promise.all([
      env.MONTHLY_BINDINGS.get(
        pKey,
        "json"
      ),

      env.MONTHLY_BINDINGS.get(
        sKey,
        "json"
      )
    ]);

  if (
    parent &&
    parent.studentId !== studentId
  ) {
    return "conflict";
  }

  if (
    student &&
    student.lineUserId !== userId
  ) {
    return "conflict";
  }

  if (
    parent?.studentId === studentId &&
    student?.lineUserId === userId
  ) {
    return "existing";
  }

  const binding = {
    teacherUid: teacherUid(env),
    studentId,
    lineUserId: userId,
    status: "active",
    boundAt:
      student?.boundAt ||
      parent?.boundAt ||
      new Date().toISOString()
  };

  await env.MONTHLY_BINDINGS.put(
    sKey,
    JSON.stringify(binding)
  );

  await env.MONTHLY_BINDINGS.put(
    pKey,
    JSON.stringify(binding)
  );

  return "created";
}

// 未來月結功能使用。
// 依學生 ID 找出應傳送的家長。
async function getBoundParent(
  env,
  studentId
) {
  const binding =
    await env.MONTHLY_BINDINGS.get(
      studentKey(env, studentId),
      "json"
    );

  if (
    !binding ||
    binding.status !== "active"
  ) {
    return null;
  }

  return binding.lineUserId || null;
}

// ========================================
// Firebase Service Account OAuth
// ========================================

let firebaseTokenCache = null;

function base64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeJwtObject(obj) {
  return base64Url(
    new TextEncoder().encode(
      JSON.stringify(obj)
    )
  );
}

function pemToArrayBuffer(pem) {
  const normalized = pem
    .replace(/\\n/g, "\n")
    .replace(
      /-----BEGIN PRIVATE KEY-----/g,
      ""
    )
    .replace(
      /-----END PRIVATE KEY-----/g,
      ""
    )
    .replace(/\s/g, "");

  return Uint8Array.from(
    atob(normalized),
    char => char.charCodeAt(0)
  ).buffer;
}

async function firebaseAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error(
      "Missing Firebase service account"
    );
  }

  let account;

  try {
    account = JSON.parse(
      env.FIREBASE_SERVICE_ACCOUNT
    );
  } catch {
    throw new Error(
      "Invalid service account JSON"
    );
  }

  if (
    !account.client_email ||
    !account.private_key
  ) {
    throw new Error(
      "Invalid service account credentials"
    );
  }

  const expectedProject =
    env.FIREBASE_PROJECT_ID ||
    PROJECT_ID;

  if (
    account.project_id &&
    account.project_id !== expectedProject
  ) {
    throw new Error(
      "Firebase project mismatch"
    );
  }

  if (
    firebaseTokenCache &&
    firebaseTokenCache.email ===
      account.client_email &&
    firebaseTokenCache.expiresAt >
      Date.now() + 60000
  ) {
    return firebaseTokenCache.accessToken;
  }

  const now = Math.floor(
    Date.now() / 1000
  );

  const tokenUri =
    "https://oauth2.googleapis.com/token";

  const header = encodeJwtObject({
    alg: "RS256",
    typ: "JWT"
  });

  const claims = encodeJwtObject({
    iss: account.client_email,

    scope:
      "https://www.googleapis.com/auth/datastore",

    aud: tokenUri,

    iat: now,

    exp: now + 3600
  });

  const unsigned =
    header + "." + claims;

  const key =
    await crypto.subtle.importKey(
      "pkcs8",

      pemToArrayBuffer(
        account.private_key
      ),

      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },

      false,

      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,

      new TextEncoder().encode(
        unsigned
      )
    );

  const assertion =
    unsigned +
    "." +
    base64Url(
      new Uint8Array(signature)
    );

  const response = await fetch(
    tokenUri,

    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",

        assertion
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      "Google OAuth failed: " +
      response.status
    );
  }

  const token = await response.json();

  if (!token.access_token) {
    throw new Error(
      "Missing Google access token"
    );
  }

  firebaseTokenCache = {
    email: account.client_email,

    accessToken: token.access_token,

    expiresAt:
      Date.now() +
      Number(token.expires_in || 3600) *
        1000
  };

  return token.access_token;
}

// ========================================
// 查詢 TutorFlow 學生索引
// ========================================

async function findStudentsByExactName(
  env,
  name
) {
  const accessToken =
    await firebaseAccessToken(env);

  const uid = teacherUid(env);

  const endpoint =
    firestoreBase(env) +
    "/teachers/" +
    encodeURIComponent(uid) +
    ":runQuery";

  const response = await fetch(
    endpoint,

    {
      method: "POST",

      headers: {
        Authorization:
          "Bearer " + accessToken,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        structuredQuery: {
          from: [
            {
              collectionId:
                "studentBindingIndex"
            }
          ],

          where: {
            fieldFilter: {
              field: {
                fieldPath: "name"
              },

              op: "EQUAL",

              value: {
                stringValue: name
              }
            }
          },

          limit: 10
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      "Firestore student query failed: " +
      response.status
    );
  }

  const results = await response.json();

  const matches = [];

  for (const item of results) {
    const doc = item.document;

    if (!doc) continue;

    const data =
      decodeFirestoreFields(
        doc.fields || {}
      );

    if (
      data.name !== name ||
      data.active !== true
    ) {
      continue;
    }

    matches.push({
      id: doc.name.split("/").pop()
    });
  }

  return matches;
}

// ========================================
// 幾何 PNG 圖示
// ========================================

function iconPNG(name) {
  const W = 96;
  const H = 96;

  const pixels =
    new Uint8Array(W * H * 4);

  const rgb = [23, 107, 83];

  function dot(x, y, radius = 2.7) {
    for (
      let j = Math.max(
        0,
        Math.floor(y - radius)
      );

      j <= Math.min(
        H - 1,
        Math.ceil(y + radius)
      );

      j++
    ) {
      for (
        let i = Math.max(
          0,
          Math.floor(x - radius)
        );

        i <= Math.min(
          W - 1,
          Math.ceil(x + radius)
        );

        i++
      ) {
        if (
          (i - x) ** 2 +
          (j - y) ** 2 <=
          radius ** 2
        ) {
          const k =
            (j * W + i) * 4;

          pixels[k] = rgb[0];
          pixels[k + 1] = rgb[1];
          pixels[k + 2] = rgb[2];
          pixels[k + 3] = 255;
        }
      }
    }
  }

  function line(x, y, a, b, radius = 2.7) {
    const n = Math.max(
      1,
      Math.ceil(
        Math.hypot(a - x, b - y) * 2
      )
    );

    for (let i = 0; i <= n; i++) {
      dot(
        x + (a - x) * i / n,
        y + (b - y) * i / n,
        radius
      );
    }
  }

  function path(points, close = false) {
    for (
      let i = 1;
      i < points.length;
      i++
    ) {
      line(
        ...points[i - 1],
        ...points[i]
      );
    }

    if (close) {
      line(
        ...points.at(-1),
        ...points[0]
      );
    }
  }

  function rect(x, y, w, h) {
    path(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h]
      ],
      true
    );
  }

  function circ(x, y, radius) {
    for (let i = 0; i < 120; i++) {
      const a = i * Math.PI / 60;

      dot(
        x + Math.cos(a) * radius,
        y + Math.sin(a) * radius,
        2.5
      );
    }
  }

  if (name === "teacher") {
    rect(13, 17, 70, 48);

    line(25, 31, 44, 31);
    line(25, 42, 38, 42);

    circ(65, 37, 8);

    path([
      [48, 60],
      [52, 51],
      [77, 51],
      [80, 60]
    ]);

    line(32, 65, 28, 78);
    line(62, 65, 66, 78);
    line(21, 78, 74, 78);
  }

  if (name === "price") {
    path(
      [
        [17, 38],
        [43, 16],
        [78, 16],
        [78, 48],
        [51, 79],
        [17, 47]
      ],
      true
    );

    circ(65, 29, 5);

    line(34, 46, 55, 46);
    line(34, 58, 49, 58);
  }

  if (name === "calendar") {
    rect(15, 24, 66, 57);

    line(15, 41, 81, 41);
    line(31, 16, 31, 31);
    line(65, 16, 65, 31);

    for (const x of [32, 48, 64]) {
      dot(x, 55, 4);
    }

    for (const x of [32, 48]) {
      dot(x, 69, 4);
    }
  }

  if (name === "policy") {
    rect(24, 20, 55, 63);
    rect(39, 13, 24, 13);

    for (const y of [44, 58, 71]) {
      rect(33, y - 3, 6, 6);
      line(49, y, 69, y);
    }
  }

  if (name === "home") {
    path([
      [15, 46],
      [48, 17],
      [81, 46]
    ]);

    line(23, 41, 23, 79);
    line(73, 41, 73, 79);
    line(23, 79, 73, 79);

    rect(39, 55, 17, 24);
    rect(59, 49, 9, 9);
  }

  if (name === "laptop") {
    rect(19, 20, 58, 42);

    path(
      [
        [19, 62],
        [11, 77],
        [85, 77],
        [77, 62]
      ],
      true
    );

    line(35, 69, 61, 69);
  }

  if (name === "binding") {
    rect(15, 20, 66, 57);

    circ(36, 38, 9);

    path([
      [21, 64],
      [26, 54],
      [46, 54],
      [50, 64]
    ]);

    path([
      [57, 48],
      [63, 54],
      [73, 41]
    ]);
  }

  return makePNG(pixels, W, H);
}

// ========================================
// PNG 編碼器
// ========================================

function makePNG(rgba, w, h) {
  const raw = new Uint8Array(
    h * (w * 4 + 1)
  );

  for (let y = 0; y < h; y++) {
    raw.set(
      rgba.subarray(
        y * w * 4,
        (y + 1) * w * 4
      ),

      y * (w * 4 + 1) + 1
    );
  }

  let a = 1;
  let b = 0;

  for (const value of raw) {
    a = (a + value) % 65521;
    b = (b + a) % 65521;
  }

  const adler =
    ((b << 16) | a) >>> 0;

  const z = [120, 1];

  for (let o = 0; o < raw.length;) {
    const n = Math.min(
      65535,
      raw.length - o
    );

    const last =
      o + n >= raw.length;

    z.push(
      last ? 1 : 0,
      n & 255,
      n >> 8,
      (~n) & 255,
      ((~n) >> 8) & 255
    );

    for (let j = 0; j < n; j++) {
      z.push(raw[o + j]);
    }

    o += n;
  }

  z.push(
    adler >>> 24,
    (adler >>> 16) & 255,
    (adler >>> 8) & 255,
    adler & 255
  );

  const u32 = n => [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255
  ];

  function crc(bytes) {
    let value = 0xffffffff;

    for (const byte of bytes) {
      value ^= byte;

      for (let j = 0; j < 8; j++) {
        value =
          (value >>> 1) ^
          (
            (value & 1)
              ? 0xedb88320
              : 0
          );
      }
    }

    return (
      value ^ 0xffffffff
    ) >>> 0;
  }

  function chunk(type, data) {
    const content = [
      ...new TextEncoder().encode(type),
      ...data
    ];

    return [
      ...u32(data.length),
      ...content,
      ...u32(crc(content))
    ];
  }

  return new Uint8Array([
    137, 80, 78, 71,
    13, 10, 26, 10,

    ...chunk(
      "IHDR",
      [
        ...u32(w),
        ...u32(h),
        8, 6, 0, 0, 0
      ]
    ),

    ...chunk("IDAT", z),

    ...chunk("IEND", [])
  ]);
}

// ========================================
// Rich Menu 管理頁
// ========================================

function adminPage() {
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1">
<meta name="robots"
      content="noindex,nofollow">

<title>TutorFlow 圖文選單管理</title>

<style>
* {
  box-sizing: border-box;
}

body {
  font-family: system-ui, sans-serif;
  background: #f5f8f5;
  color: #273b45;
  margin: 0;
  padding: 24px;
}

main {
  max-width: 580px;
  margin: 30px auto;
  background: white;
  border: 1px solid #e5ece7;
  border-radius: 20px;
  padding: 28px;
}

h1 {
  color: #155542;
  font-size: 23px;
}

p {
  color: #687889;
  font-size: 14px;
  line-height: 1.8;
}

label {
  display: block;
  margin: 22px 0 8px;
  font-weight: 600;
}

input {
  width: 100%;
  padding: 13px;
  border: 1px solid #c8d7cd;
  border-radius: 10px;
}

button {
  width: 100%;
  background: #176b53;
  color: white;
  border: 0;
  border-radius: 10px;
  padding: 14px;
  margin-top: 24px;
  cursor: pointer;
}

pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #eaf4ed;
  padding: 14px;
  border-radius: 10px;
  font-size: 13px;
}
</style>
</head>

<body>
<main>

<h1>單一圖文選單管理</h1>

<p>
保留原本的「查看選單」圖片。
家長點擊後，Worker 將回覆五個 Quick Reply。
</p>

<form id="form">

<label>管理密鑰</label>

<input
  id="secret"
  type="password"
  autocomplete="off"
  required
>

<label>上傳圖文選單 PNG</label>

<input
  id="file"
  type="file"
  accept="image/png"
  required
>

<p>
圖片上限 1 MB，寬度 800–2500 px，
高度至少 250 px，寬高比至少 1.45。
</p>

<button id="submit">
上傳並啟用圖文選單
</button>

</form>

<pre id="result" hidden></pre>

</main>

<script>
const form =
  document.getElementById("form");

const result =
  document.getElementById("result");

const button =
  document.getElementById("submit");

form.addEventListener(
  "submit",

  async event => {
    event.preventDefault();

    const file =
      document.getElementById("file")
        .files[0];

    if (!file) return;

    result.hidden = false;

    if (file.size > 1048576) {
      result.textContent =
        "圖片不可超過 1 MB。";
      return;
    }

    button.disabled = true;

    result.textContent =
      "正在設定圖文選單...";

    try {
      const data = new FormData();

      data.append(
        "image",
        file,
        file.name
      );

      const response = await fetch(
        "/admin/richmenu/install",

        {
          method: "POST",

          headers: {
            Authorization:
              "Bearer " +
              document.getElementById(
                "secret"
              ).value
          },

          body: data,

          cache: "no-store"
        }
      );

      const json =
        await response.json();

      if (!response.ok) {
        throw new Error(
          json.error || "設定失敗"
        );
      }

      result.textContent =
        "成功啟用！\\nRich Menu ID：" +
        json.richMenuId;

    } catch (error) {
      result.textContent =
        "設定失敗：" + error.message;

    } finally {
      button.disabled = false;
    }
  }
);
</script>

</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type":
        "text/html; charset=utf-8",

      "Cache-Control":
        "no-store",

      "X-Content-Type-Options":
        "nosniff",

      "X-Frame-Options":
        "DENY",

      "Referrer-Policy":
        "no-referrer",

      "Content-Security-Policy":
        "default-src 'none'; " +
        "script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; " +
        "connect-src 'self'; " +
        "form-action 'self'; " +
        "base-uri 'none'"
    }
  });
}

// ========================================
// 管理員密鑰驗證
// ========================================

async function verifyAdmin(request, expected) {
  const token = (
    request.headers.get(
      "authorization"
    ) || ""
  ).replace(/^Bearer\s+/i, "");

  if (
    !expected ||
    !token ||
    token.length > 512
  ) {
    return false;
  }

  const encoder =
    new TextEncoder();

  const [a, b] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(token)
    ),

    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(expected)
    )
  ]);

  const x = new Uint8Array(a);
  const y = new Uint8Array(b);

  let diff = 0;

  for (let i = 0; i < x.length; i++) {
    diff |= x[i] ^ y[i];
  }

  return diff === 0;
}

function jsonReply(body, status = 200) {
  return new Response(
    JSON.stringify(body),

    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        "X-Content-Type-Options":
          "nosniff"
      }
    }
  );
}

// ========================================
// Rich Menu API
// ========================================

async function lineAdminFetch(
  path,
  token,
  options = {},
  dataDomain = false
) {
  const base = dataDomain
    ? "https://api-data.line.me"
    : "https://api.line.me";

  const response = await fetch(
    base + path,

    {
      ...options,

      headers: {
        Authorization:
          "Bearer " + token,

        ...(options.headers || {})
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      "LINE API failed: " +
      response.status
    );
  }

  if (response.status === 204) {
    return {};
  }

  const text =
    await response.text();

  return text
    ? JSON.parse(text)
    : {};
}

async function installRichMenu(
  request,
  env
) {
  if (!env.RICHMENU_ADMIN_KEY) {
    return jsonReply(
      {
        error:
          "尚未設定 RICHMENU_ADMIN_KEY。"
      },
      503
    );
  }

  if (
    !await verifyAdmin(
      request,
      env.RICHMENU_ADMIN_KEY
    )
  ) {
    return jsonReply(
      {
        error: "管理密鑰錯誤。"
      },
      401
    );
  }

  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return jsonReply(
      {
        error:
          "缺少 LINE Access Token。"
      },
      503
    );
  }

  const type =
    request.headers.get(
      "content-type"
    ) || "";

  if (
    !type.startsWith(
      "multipart/form-data"
    )
  ) {
    return jsonReply(
      {
        error: "請上傳 PNG 圖片。"
      },
      415
    );
  }

  const length = Number(
    request.headers.get(
      "content-length"
    ) || 0
  );

  if (length > 1400000) {
    return jsonReply(
      {
        error: "上傳內容過大。"
      },
      413
    );
  }

  let file;

  try {
    const form =
      await request.formData();

    file = form.get("image");

  } catch {
    return jsonReply(
      {
        error: "上傳格式不正確。"
      },
      400
    );
  }

  if (
    !file ||
    typeof file.arrayBuffer !==
      "function" ||
    file.size < 24 ||
    file.size > 1048576
  ) {
    return jsonReply(
      {
        error: "請選擇有效的 PNG 圖片。"
      },
      400
    );
  }

  const bytes = new Uint8Array(
    await file.arrayBuffer()
  );

  const pngSig = [
    137, 80, 78, 71,
    13, 10, 26, 10
  ];

  if (
    !pngSig.every(
      (n, i) => bytes[i] === n
    ) ||

    String.fromCharCode(
      ...bytes.slice(12, 16)
    ) !== "IHDR"
  ) {
    return jsonReply(
      {
        error: "圖片必須為 PNG 格式。"
      },
      400
    );
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const width =
    view.getUint32(16);

  const height =
    view.getUint32(20);

  if (
    width < 800 ||
    width > 2500 ||
    height < 250 ||
    height > 1686 ||
    width / height < 1.45
  ) {
    return jsonReply(
      {
        error: "圖片尺寸不符合規格。"
      },
      400
    );
  }

  const spec = {
    size: {
      width,
      height
    },

    selected: true,

    name: "TutorFlow 查看選單",

    chatBarText: "查看選單",

    areas: [
      {
        bounds: {
          x: 0,
          y: 0,
          width,
          height
        },

        action: {
          type: "postback",

          label: "查看選單",

          data: "menu_open",

          inputOption:
            "closeRichMenu"
        }
      }
    ]
  };

  let id = null;
  let installed = false;

  try {
    const token =
      env.LINE_CHANNEL_ACCESS_TOKEN;

    await lineAdminFetch(
      "/v2/bot/richmenu/validate",

      token,

      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify(spec)
      }
    );

    const created =
      await lineAdminFetch(
        "/v2/bot/richmenu",

        token,

        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify(spec)
        }
      );

    id = created.richMenuId;

    if (
      !id ||
      !/^richmenu-[A-Za-z0-9]+$/.test(id)
    ) {
      throw new Error(
        "無效的 Rich Menu ID"
      );
    }

    await lineAdminFetch(
      "/v2/bot/richmenu/" +
      id +
      "/content",

      token,

      {
        method: "POST",

        headers: {
          "Content-Type": "image/png"
        },

        body: bytes
      },

      true
    );

    await lineAdminFetch(
      "/v2/bot/user/all/richmenu/" + id,

      token,

      {
        method: "POST"
      }
    );

    installed = true;

    return jsonReply({
      ok: true,
      richMenuId: id
    });

  } catch (error) {
    console.error(
      "Rich Menu install failed:",
      error?.message
    );

    if (id && !installed) {
      try {
        await lineAdminFetch(
          "/v2/bot/richmenu/" + id,

          env.LINE_CHANNEL_ACCESS_TOKEN,

          {
            method: "DELETE"
          }
        );
      } catch {
        console.error(
          "Rich Menu cleanup failed"
        );
      }
    }

    return jsonReply(
      {
        error:
          "圖文選單設定失敗。"
      },
      502
    );
  }
}

// ========================================
// 老師月結管理
// ========================================

async function handleMonthlyAdmin(request, env, pathname) {
  const isStudentList = pathname === "/admin/monthly-students";
  if (request.method !== (isStudentList ? "GET" : "POST")) {
    return jsonReply({error: "不支援這個請求方式。"}, 405);
  }
  const monthlyKey = env.MONTHLY_ADMIN_KEY;
  if (typeof monthlyKey !== "string" || monthlyKey.length < 32 || monthlyKey.length > 512 ||
      monthlyKey === env.RICHMENU_ADMIN_KEY) {
    return jsonReply({error: "請在 Worker 設定獨立的 MONTHLY_ADMIN_KEY，長度至少 32 字元。"}, 503);
  }
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ") || !await verifyAdmin(request, monthlyKey)) {
    return jsonReply({error: "月結管理密鑰不正確。"}, 403);
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonReply({error: "請從老師月結管理頁操作。"}, 403);
  }

  let selection;
  if (!isStudentList) {
    selection = await request.json().catch(() => null);
    if (typeof selection?.studentId !== "string" || !/^[\w.-]{1,160}$/.test(selection.studentId) ||
        typeof selection?.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(selection.month)) {
      return jsonReply({error: "請選擇有效的學生與月份。"}, 400);
    }
  }

  try {
    const uid = teacherUid(env);
    const accessToken = await firebaseAccessToken(env);
    if (isStudentList) {
      return jsonReply({students: await listMonthlyStudents(env, uid, accessToken)});
    }
    const {revision, workspace} = await loadTutorFlowWorkspace({
      accessToken, teacherUid: uid, projectId: env.FIREBASE_PROJECT_ID || PROJECT_ID,
      databaseId: env.FIRESTORE_DATABASE_ID || "(default)"
    });
    return jsonReply({revision, ...tutorFlowStudentMonth(workspace, selection.studentId, selection.month)});
  } catch (error) {
    if (error.code === "workspace-not-found" || error.code === "student-not-found") {
      return jsonReply({error: error.message}, 404);
    }
    if (error.code === "workspace-conflict") {
      return jsonReply({error: error.message}, 409);
    }
    console.error("Monthly preview read failed", {code: error.code || "backend-error", message: error.message});
    return jsonReply({error: "目前無法讀取月結資料。請檢查 Firestore 讀取權限或稍後再試。"}, 502);
  }
}

async function listMonthlyStudents(env, uid, accessToken) {
  const result = await fetch(firestoreBase(env) + "/teachers/" + encodeURIComponent(uid) + ":runQuery", {
    method: "POST",
    headers: {Authorization: "Bearer " + accessToken, "Content-Type": "application/json"},
    body: JSON.stringify({
      structuredQuery: {
        from: [{collectionId: "studentBindingIndex"}],
        select: {fields: [{fieldPath: "name"}]},
        where: {fieldFilter: {field: {fieldPath: "active"}, op: "EQUAL", value: {booleanValue: true}}}
      }
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000)
  });
  if (!result.ok) throw new Error("Firestore student list failed: " + result.status);
  const rows = await result.json();
  if (!Array.isArray(rows)) throw new Error("Invalid Firestore student list");
  const students = [];
  for (const row of rows) {
    const document = row.document;
    const name = document?.fields?.name?.stringValue;
    const id = document?.name?.split("/").at(-1);
    if (id && typeof name === "string") students.push({id, name});
  }
  return students.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant") || a.id.localeCompare(b.id));
}

function monthlyAdminPage() {
  const nonce = crypto.randomUUID();
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>TutorFlow 月結管理</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;color:#273b45;background:#f7f5ee;color-scheme:light}
*{box-sizing:border-box}
body{margin:0}
main{width:min(100% - 32px,840px);margin:40px auto}
h1,h2{color:#155542;margin:0}
h1{font-size:clamp(1.6rem,5vw,2.2rem)}
h2{font-size:1.1rem}
.card{background:#fffcf8;border:1px solid #e1e8de;border-radius:20px;padding:clamp(16px,4vw,30px);margin-top:20px}
.controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:14px;align-items:end}
label{display:block;font-weight:650;margin:0 0 7px}
input,select,button{font:inherit;min-height:44px;width:100%;border-radius:10px}
input,select{padding:8px 12px;border:1px solid #bdccbf;background:#fff;color:#273b45}
button{border:0;background:#176b53;color:white;font-weight:700;padding:8px 14px;cursor:pointer}
button:disabled{opacity:.48;cursor:default}
:focus-visible{outline:3px solid #64856d;outline-offset:2px}
.status{font-size:.9rem;line-height:1.55;min-height:1.5em;margin:14px 0 0;color:#4a6554}
.status[data-error]{color:#943923}
dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:9px;margin:15px 0}
dl div{background:#eaf4ed;border-radius:12px;padding:10px 12px}
dt{font-size:.85rem}dd{margin:4px 0 0;font-weight:700}
ol{list-style:none;margin:0;padding:0}
li{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:12px 0;border-top:1px solid #e5ece7}
li strong,li small{display:block;line-height:1.6}
li small{color:#556662}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
  <h1>TutorFlow 月結管理</h1>
  <section class="card" aria-label="選擇月結資料">
    <form id="unlock" class="controls" autocomplete="off">
      <div><label for="key">月結管理密鑰</label><input id="key" type="password" required maxlength="512" autocomplete="off"></div>
      <button id="load" type="submit">載入學生</button>
    </form>
    <form id="filters" class="controls" hidden>
      <div><label for="student">學生</label><select id="student" required></select></div>
      <div><label for="month">月份</label><input id="month" type="month" required placeholder="YYYY-MM"></div>
      <button id="preview" type="submit">查看月結預覽</button>
    </form>
    <p id="status" class="status" role="status"></p>
  </section>
  <section id="result" class="card" aria-labelledby="summary" hidden>
    <h2 id="summary"></h2>
    <dl id="totals"></dl>
    <ol id="rows"></ol>
  </section>
</main>
<script nonce="${nonce}">
const byId = id => document.getElementById(id);
const key = byId("key");
const student = byId("student");
const month = byId("month");
const filters = byId("filters");
const result = byId("result");
const preview = byId("preview");
const formatter = new Intl.NumberFormat("zh-TW", {style:"currency", currency:"TWD", maximumFractionDigits:0});
const hours = new Intl.NumberFormat("zh-TW", {maximumFractionDigits:2});
const today = new Intl.DateTimeFormat("en", {timeZone:"Asia/Taipei", year:"numeric", month:"2-digit"}).formatToParts();
month.value = today.find(part => part.type === "year").value + "-" + today.find(part => part.type === "month").value;
let generation = 0;

function status(message, error = false) {
  const node = byId("status");
  node.textContent = message;
  node.toggleAttribute("data-error", error);
}

function clearPreview() {
  result.hidden = true;
  byId("summary").textContent = "";
  byId("totals").replaceChildren();
  byId("rows").replaceChildren();
}

async function requestMonthly(path, selection) {
  const headers = {Authorization:"Bearer " + key.value};
  if (selection) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method:selection ? "POST" : "GET", headers,
    body:selection ? JSON.stringify(selection) : undefined, cache:"no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "目前無法取得資料。");
  return body;
}

key.addEventListener("input", () => {
  generation++;
  filters.hidden = true;
  student.replaceChildren();
  clearPreview();
  status("");
});

byId("unlock").addEventListener("submit", async event => {
  event.preventDefault();
  const requestGeneration = ++generation;
  byId("load").disabled = true;
  filters.hidden = true;
  clearPreview();
  status("正在載入學生…");
  try {
    const {students} = await requestMonthly("/admin/monthly-students");
    if (requestGeneration !== generation) return;
    const counts = new Map();
    for (const item of students) counts.set(item.name, (counts.get(item.name) || 0) + 1);
    student.replaceChildren(new Option("選擇學生", ""), ...students.map(item =>
      new Option(counts.get(item.name) > 1 ? item.name + " · " + item.id : item.name, item.id)));
    filters.hidden = students.length === 0;
    status(students.length ? "" : "目前沒有學生索引。請先在 TutorFlow 同步學生索引。");
  } catch (error) {
    if (requestGeneration === generation) status(error.message, true);
  } finally {
    byId("load").disabled = false;
  }
});

filters.addEventListener("change", () => {
  generation++;
  clearPreview();
  status("");
});

filters.addEventListener("submit", async event => {
  event.preventDefault();
  const requestGeneration = ++generation;
  clearPreview();
  preview.disabled = true;
  status("正在讀取月結資料…");
  try {
    const data = await requestMonthly("/admin/monthly-preview", {studentId:student.value, month:month.value});
    if (requestGeneration !== generation) return;
    const totals = data.totals;
    const headings = [
      ["應收", formatter.format(totals.due)], ["已收", formatter.format(totals.paid)],
      ["待收", formatter.format(totals.unpaid)], ["預約試算", formatter.format(totals.scheduledEstimate)],
      ["已完成時數", hours.format(totals.completedHours) + " 小時"],
      ["預約時數", hours.format(totals.scheduledHours) + " 小時"]
    ];
    byId("summary").textContent = data.studentName + " · " + data.month;
    for (const [label, value] of headings) {
      const box = document.createElement("div");
      const term = document.createElement("dt");
      const amount = document.createElement("dd");
      term.textContent = label;
      amount.textContent = value;
      box.append(term, amount);
      byId("totals").append(box);
    }
    for (const row of data.rows) {
      const item = document.createElement("li");
      const details = document.createElement("div");
      const time = document.createElement("strong");
      const state = document.createElement("small");
      const money = document.createElement("strong");
      time.textContent = row.date + " · " + row.start + "–" + row.end;
      const scheduled = row.status === "scheduled";
      state.textContent = hours.format(row.hours) + " 小時 · " + (scheduled ? "預約中" : row.paid ? "已收款" : "未收款");
      money.textContent = (scheduled ? "試算 " : "") + formatter.format(scheduled ? row.estimate : row.amountDue);
      details.append(time, state);
      item.append(details, money);
      byId("rows").append(item);
    }
    result.hidden = false;
    status(data.rows.length ? "" : "這個月份沒有可列出的課程。");
  } catch (error) {
    if (requestGeneration === generation) status(error.message, true);
  } finally {
    preview.disabled = false;
  }
});
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce +
        "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}

// Imports are not required. Pass the OAuth access token from your existing Worker.
const TUTORFLOW_MAX_CHUNKS = 32;

function tutorFlowError(code, message) {
  return Object.assign(new Error(message), {code});
}

function parseTutorFlowHead(row, name) {
  if (row?.missing === name) {
    throw tutorFlowError('workspace-not-found', '找不到老師的工作區。');
  }
  const document = row?.found;
  const fields = document?.fields;
  const revision = Number(fields?.revision?.integerValue);
  const chunkCount = Number(fields?.chunkCount?.integerValue);
  if (document?.name !== name || !document.updateTime ||
      Number(fields?.version?.integerValue) !== 1 ||
      !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > TUTORFLOW_MAX_CHUNKS) {
    throw tutorFlowError('invalid-workspace', '工作區 head 的格式或分塊數有誤。');
  }
  return {
    revision, chunkCount, updateTime: document.updateTime,
    mutationId: fields.mutationId?.stringValue ?? ''
  };
}

function decodeTutorFlowChunks(rows, names) {
  const payloadByName = new Map(rows.filter(row => row.found).map(row => [
    row.found.name, row.found.fields?.payload?.stringValue
  ]));
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let json = '';
  for (const [index, name] of names.entries()) {
    const payload = payloadByName.get(name);
    if (typeof payload !== 'string' || !payload) {
      throw tutorFlowError('missing-chunk', '工作區缺少分塊 ' + index + ' 的 payload。');
    }
    try {
      // Each payload has its own Base64 encoding and padding. Decode bytes first.
      const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
      json += decoder.decode(bytes, {stream: true});
    } catch {
      throw tutorFlowError('invalid-chunk', '工作區分塊 ' + index + ' 無法解碼。');
    }
  }
  let workspace;
  try {
    json += decoder.decode();
    workspace = JSON.parse(json);
  } catch {
    throw tutorFlowError('invalid-workspace', '分塊合併後的工作區無法解析。');
  }
  if (!Array.isArray(workspace?.students) || !Array.isArray(workspace?.courses)) {
    throw tutorFlowError('invalid-workspace', '工作區缺少 students 或 courses 陣列。');
  }
  return workspace;
}

// Server-side only. Resolve teacherUid from your authorized teacher session.
async function loadTutorFlowWorkspace({
  accessToken, teacherUid, projectId = 'turtorflow', databaseId = '(default)', fetcher = fetch
}) {
  if (typeof teacherUid !== 'string' || !/^[^/\s]{1,128}$/.test(teacherUid) ||
      /^(__.*__|\.{1,2})$/.test(teacherUid) || !accessToken) {
    throw tutorFlowError('invalid-argument', '缺少受授權的老師 UID 或 OAuth access token。');
  }
  const resource = 'projects/' + projectId + '/databases/' + databaseId;
  const headName = resource + '/documents/teachers/' + teacherUid + '/workspace/head';
  const endpoint = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) +
    '/databases/' + encodeURIComponent(databaseId) + '/documents:batchGet';

  async function batchGet(documents) {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json'},
      body: JSON.stringify({documents}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      throw tutorFlowError('firestore-read-failed', 'Firestore 讀取失敗（HTTP ' + response.status + '）。');
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) {
      throw tutorFlowError('invalid-response', 'Firestore 回傳的文件格式不正確。');
    }
    return rows;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const [firstRow] = await batchGet([headName]);
    const first = parseTutorFlowHead(firstRow, headName);
    const names = Array.from({length: first.chunkCount}, (_, index) => headName + '/chunks/' + index);
    const rows = await batchGet(names);
    const [latestRow] = await batchGet([headName]);
    const latest = parseTutorFlowHead(latestRow, headName);
    if (first.revision !== latest.revision || first.chunkCount !== latest.chunkCount ||
        first.mutationId !== latest.mutationId || first.updateTime !== latest.updateTime) {
      continue;
    }
    return {
      revision: first.revision,
      chunkCount: first.chunkCount,
      workspace: decodeTutorFlowChunks(rows, names)
    };
  }
  throw tutorFlowError('workspace-conflict', '工作區正在更新，請重新載入月結預覽。');
}

function tutorFlowCourseHours(course) {
  // Both ends are on the same local teaching date in Taiwan.
  const start = Date.parse(course.date + 'T' + course.start + ':00+08:00');
  const end = Date.parse(course.date + 'T' + course.end + ':00+08:00');
  return Math.max(0, (end - start) / 3600000);
}

function tutorFlowCourseAmount(course) {
  return tutorFlowCourseHours(course) * (Number(course.rateSnapshot) || 0);
}

function tutorFlowStudentMonth(workspace, studentId, month) {
  if (typeof studentId !== 'string' || !/^[\w.-]{1,160}$/.test(studentId) ||
      typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw tutorFlowError('invalid-argument', '請使用有效的 studentId 和 YYYY-MM。');
  }
  const student = workspace.students.find(item => item.id === studentId);
  const studentCourses = workspace.courses.filter(course => course.studentId === studentId);
  if (!student && !studentCourses.length) {
    throw tutorFlowError('student-not-found', '工作區沒有此學生或其歷史課程。');
  }
  const historicalName = studentCourses.find(course => course.studentNameSnapshot)?.studentNameSnapshot;
  const rows = [];
  const seen = new Set();
  const totals = {completedHours: 0, due: 0, paid: 0, unpaid: 0, scheduledHours: 0, scheduledEstimate: 0};
  for (const course of studentCourses) {
    if (!course.date.startsWith(month + '-') || !['scheduled', 'completed'].includes(course.status) ||
        seen.has(course.id)) continue;
    seen.add(course.id);
    const hours = tutorFlowCourseHours(course);
    const amount = tutorFlowCourseAmount(course);
    if (!Number.isFinite(hours) || !Number.isFinite(amount)) {
      throw tutorFlowError('invalid-course', '指定學生與月份有無法計算的課程資料。');
    }
    const completed = course.status === 'completed';
    const paid = completed && Boolean(course.paid);
    rows.push({
      id: course.id, date: course.date, start: course.start, end: course.end,
      status: course.status, hours, rateSnapshot: Number(course.rateSnapshot) || 0,
      amountDue: completed ? amount : 0, paid, estimate: completed ? 0 : amount
    });
    if (completed) {
      totals.completedHours += hours;
      totals.due += amount;
      if (paid) totals.paid += amount;
    } else {
      totals.scheduledHours += hours;
      totals.scheduledEstimate += amount;
    }
  }
  totals.unpaid = totals.due - totals.paid;
  rows.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start) || a.id.localeCompare(b.id));
  return {studentId, studentName: student?.name ?? historicalName ?? '未指定學生', month, rows, totals};
}

const defaultProject = PROJECT_ID;

export async function handleStudentLookup(request, env, fetcher = fetch) {
  const origin = request.headers.get("Origin");
  const allowedOrigin = env.TUTORFLOW_ADMIN_ORIGIN || "https://naco727.github.io";
  const headers = {"Cache-Control": "no-store", "Vary": "Origin"};
  const reply = (body, status = 200) => Response.json(body, {status, headers});
  if (origin) {
    if (origin !== allowedOrigin && origin !== new URL(request.url).origin) {
      return reply({code: "forbidden"}, 403);
    }
    headers["Access-Control-Allow-Origin"] = origin;
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {status: 204, headers: {
      ...headers,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type"
    }});
  }
  if (request.method !== "POST") return reply({code: "method-not-allowed"}, 405);
  const idToken = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)?.[1];
  if (!idToken || idToken.length > 8192) return reply({code: "unauthenticated"}, 401);
  const teacherUid = env.TUTORFLOW_TEACHER_UID || env.TEACHER_UID;
  const apiKey = env.FIREBASE_WEB_API_KEY;
  if (!apiKey || typeof teacherUid !== "string" || !/^[^/\s]{1,128}$/.test(teacherUid) ||
      /^(__.*__|\.{1,2})$/.test(teacherUid)) return reply({code: "not-configured"}, 503);

  try {
    const post = (url, body, authorization = {}) => fetcher(url, {
      method: "POST",
      headers: {"Content-Type": "application/json", ...authorization},
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });
    const authUrl = new URL("https://identitytoolkit.googleapis.com/v1/accounts:lookup");
    authUrl.searchParams.set("key", apiKey);
    const auth = await post(authUrl.href, {idToken});
    if (!auth.ok) return auth.status === 400 || auth.status === 401
      ? reply({code: "unauthenticated"}, 401) : reply({code: "lookup-unavailable"}, 503);

    const {users} = await auth.json();
    const teacher = users?.[0];
    if (users?.length !== 1 || teacher?.localId !== teacherUid || teacher.emailVerified !== true || teacher.disabled) {
      return reply({code: "forbidden"}, 403);
    }
    const body = await request.json().catch(() => null);
    const name = body?.name;
    if (typeof name !== "string" || !name.trim() || new TextEncoder().encode(name).length > 1500) {
      return reply({code: "invalid-name"}, 400);
    }

    const project = env.FIREBASE_PROJECT_ID || defaultProject;
    const database = env.FIRESTORE_DATABASE_ID || "(default)";
    const parent = "projects/" + encodeURIComponent(project) + "/databases/" + encodeURIComponent(database) +
      "/documents/teachers/" + encodeURIComponent(teacherUid);
    const response = await post("https://firestore.googleapis.com/v1/" + parent + ":runQuery", {
      structuredQuery: {
        from: [{collectionId: "studentBindingIndex"}],
        select: {fields: [{fieldPath: "name"}]},
        where: {compositeFilter: {op: "AND", filters: [
          {fieldFilter: {field: {fieldPath: "name"}, op: "EQUAL", value: {stringValue: name}}},
          {fieldFilter: {field: {fieldPath: "active"}, op: "EQUAL", value: {booleanValue: true}}}
        ]}},
        limit: 2
      }
    }, {Authorization: "Bearer " + idToken});
    if (response.status === 401) return reply({code: "unauthenticated"}, 401);
    if (response.status === 403) return reply({code: "forbidden"}, 403);
    if (!response.ok) return reply({code: "lookup-unavailable"}, 503);
    const rows = (await response.json()).flatMap(row => row.document ? [row.document] : []);
    if (rows.length !== 1) return reply({status: rows.length ? "ambiguous" : "not-found"});
    const document = rows[0];
    const studentId = document.name?.split("/").at(-1);
    if (!studentId || document.fields?.name?.stringValue !== name) return reply({code: "lookup-unavailable"}, 503);
    return reply({status: "matched", student: {id: studentId, name}});
  } catch {
    return reply({code: "lookup-unavailable"}, 503);
  }
}
