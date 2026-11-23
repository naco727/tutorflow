/**
 * TutorFlow LINE Bot
 * Cloudflare Workers 完整版本
 *
 * 功能：
 * 1. 單一 Rich Menu Postback
 * 2. 四個 Quick Reply
 * 3. 教學經驗與成果
 * 4. 課程費用
 * 5. Firestore 可預約時段
 * 6. 上課須知
 * 7. 幾何 PNG 圖示
 * 8. Rich Menu 圖片上傳管理頁
 *
 * Cloudflare Secrets：
 * LINE_CHANNEL_SECRET
 * LINE_CHANNEL_ACCESS_TOKEN
 * RICHMENU_ADMIN_KEY
 *
 * Variables：
 * TEACHER_UID
 * LINE_OA_ID
 * FIREBASE_PROJECT_ID（選填，預設 turtorflow）
 * FIRESTORE_DATABASE_ID（選填，預設 (default)）
 * ICON_BASE_URL（選填）
 */

const PROJECT_ID = "turtorflow";

const MAX_DAYS = 12;
const MAX_TIMES_PER_DAY = 4;

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

// =====================================
// Worker 入口
// =====================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 圖文選單管理頁
    if (url.pathname === "/admin/richmenu") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }

      return adminPage();
    }

    // 管理頁：上傳並啟用
    if (url.pathname === "/admin/richmenu/install") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }

      return installRichMenu(request, env);
    }

    // 幾何圖示
    const iconMatch = url.pathname.match(
      /^\/icons\/(teacher|price|calendar|policy|home|laptop)\.png$/
    );

    if (iconMatch) {
      return new Response(iconPNG(iconMatch[1]), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 健康檢查
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

    const rawBody = await request.text();

    const verified = await validSignature(
      rawBody,
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
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", {
        status: 400
      });
    }

    const base = (
      env.ICON_BASE_URL || url.origin
    ).replace(/\/+$/, "");

    ctx.waitUntil(
      Promise.allSettled(
        (payload.events || []).map(event =>
          handleEvent(event, env, base)
        )
      )
    );

    return new Response("OK");
  }
};

// =====================================
// LINE Webhook 簽章
// =====================================

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

    const signatureBytes = Uint8Array.from(
      atob(signature),
      c => c.charCodeAt(0)
    );

    return crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(body)
    );
  } catch {
    return false;
  }
}

// =====================================
// 自動繪製幾何圖示
// =====================================

function iconPNG(name) {
  const W = 96;
  const H = 96;

  const pixels = new Uint8Array(W * H * 4);
  const rgb = [23, 107, 83];

  function dot(x, y, radius = 2.7) {
    for (
      let j = Math.max(0, Math.floor(y - radius));
      j <= Math.min(H - 1, Math.ceil(y + radius));
      j++
    ) {
      for (
        let i = Math.max(0, Math.floor(x - radius));
        i <= Math.min(W - 1, Math.ceil(x + radius));
        i++
      ) {
        const distance =
          (i - x) ** 2 + (j - y) ** 2;

        if (distance <= radius * radius) {
          const k = (j * W + i) * 4;

          pixels[k] = rgb[0];
          pixels[k + 1] = rgb[1];
          pixels[k + 2] = rgb[2];
          pixels[k + 3] = 255;
        }
      }
    }
  }

  function line(x, y, a, b, radius = 2.7) {
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(a - x, b - y) * 2)
    );

    for (let i = 0; i <= steps; i++) {
      dot(
        x + (a - x) * i / steps,
        y + (b - y) * i / steps,
        radius
      );
    }
  }

  function path(points, closed = false) {
    for (let i = 1; i < points.length; i++) {
      line(...points[i - 1], ...points[i]);
    }

    if (closed) {
      line(...points.at(-1), ...points[0]);
    }
  }

  function rect(x, y, w, h) {
    path([
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h]
    ], true);
  }

  function circle(x, y, radius) {
    for (let i = 0; i < 120; i++) {
      const angle = i * Math.PI / 60;

      dot(
        x + Math.cos(angle) * radius,
        y + Math.sin(angle) * radius,
        2.5
      );
    }
  }

  if (name === "teacher") {
    rect(13, 17, 70, 48);
    line(25, 31, 44, 31);
    line(25, 42, 38, 42);

    circle(65, 37, 8);

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
    path([
      [17, 38],
      [43, 16],
      [78, 16],
      [78, 48],
      [51, 79],
      [17, 47]
    ], true);

    circle(65, 29, 5);

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

    path([
      [19, 62],
      [11, 77],
      [85, 77],
      [77, 62]
    ], true);

    line(35, 69, 61, 69);
  }

  return makePNG(pixels, W, H);
}

// =====================================
// PNG 編碼器
// =====================================

function makePNG(rgba, width, height) {
  const raw = new Uint8Array(
    height * (width * 4 + 1)
  );

  for (let y = 0; y < height; y++) {
    raw.set(
      rgba.subarray(
        y * width * 4,
        (y + 1) * width * 4
      ),
      y * (width * 4 + 1) + 1
    );
  }

  let a = 1;
  let b = 0;

  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }

  const adler = ((b << 16) | a) >>> 0;
  const compressed = [120, 1];

  for (let offset = 0; offset < raw.length;) {
    const n = Math.min(
      65535,
      raw.length - offset
    );

    const last = offset + n >= raw.length;

    compressed.push(
      last ? 1 : 0,
      n & 255,
      n >> 8,
      (~n) & 255,
      ((~n) >> 8) & 255
    );

    for (let i = 0; i < n; i++) {
      compressed.push(raw[offset + i]);
    }

    offset += n;
  }

  compressed.push(
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

  function crc32(bytes) {
    let crc = 0xffffffff;

    for (const byte of bytes) {
      crc ^= byte;

      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^
          ((crc & 1) ? 0xedb88320 : 0);
      }
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const content = [
      ...new TextEncoder().encode(type),
      ...data
    ];

    return [
      ...u32(data.length),
      ...content,
      ...u32(crc32(content))
    ];
  }

  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,

    ...chunk("IHDR", [
      ...u32(width),
      ...u32(height),
      8, 6, 0, 0, 0
    ]),

    ...chunk("IDAT", compressed),
    ...chunk("IEND", [])
  ]);
}

// =====================================
// LINE Flex 共用元件
// =====================================

const t = (text, options = {}) => ({
  type: "text",
  text: String(text),
  size: "sm",
  color: C.dark,
  wrap: true,
  ...options
});

const b = (contents, options = {}) => ({
  type: "box",
  layout: "vertical",
  contents,
  ...options
});

const r = (contents, options = {}) => ({
  type: "box",
  layout: "horizontal",
  contents,
  alignItems: "center",
  ...options
});

const sep = (margin = "md") => ({
  type: "separator",
  color: C.line,
  margin
});

const dollars = n =>
  "$" + n.toLocaleString("en-US");

const icon = (base, name, size = "30px") => ({
  type: "image",
  url: `${base}/icons/${name}.png`,
  size,
  aspectRatio: "1:1",
  aspectMode: "fit",
  flex: 0
});

// =====================================
// Quick Reply
// 全部使用 Postback
// =====================================

function quickReply(base) {
  const buttons = [
    ["教學經驗", "menu_experience", "teacher"],
    ["課程費用", "menu_price", "price"],
    ["詢問時段", "menu_availability", "calendar"],
    ["上課須知", "menu_policy", "policy"]
  ];

  return {
    items: buttons.map(([label, data, name]) => ({
      type: "action",
      imageUrl: `${base}/icons/${name}.png`,
      action: {
        type: "postback",
        label,
        data
      }
    }))
  };
}

const textMessage = (text, base) => ({
  type: "text",
  text,
  quickReply: quickReply(base)
});

const flexMessage = (altText, contents, base) => ({
  type: "flex",
  altText,
  contents,
  quickReply: quickReply(base)
});

// =====================================
// 淺色品牌標頭
// =====================================

function lightHeader(name, title, subtitle, base) {
  return b([
    r([
      b([
        icon(base, name, "35px")
      ], {
        backgroundColor: C.mint,
        cornerRadius: "12px",
        paddingAll: "9px",
        flex: 0
      }),

      b([
        t("NAMI TUTOR", {
          size: "xxs",
          color: C.muted
        }),

        t(title, {
          size: "xl",
          weight: "bold",
          color: C.deep
        }),

        t(subtitle, {
          size: "xs",
          color: C.muted
        })
      ], {
        flex: 1,
        spacing: "xs",
        margin: "md"
      })
    ], {
      spacing: "sm"
    })
  ], {
    backgroundColor: C.cream,
    paddingAll: "20px"
  });
}

// =====================================
// 歡迎訊息
// =====================================

function welcome(base) {
  return textMessage(
    "您好！歡迎。我是睿庭。\n\n" +
    "請使用下方選單查看教學經驗、" +
    "課程費用、預約時段及上課須知。" +
    "或者您可以直接傳訊息，我將盡速回覆。",
    base
  );
}

// =====================================
// 教師介紹
// =====================================

function introCard(base) {
  return {
    type: "bubble",
    size: "mega",

    header: lightHeader(
      "teacher",
      "關於老師",
      "國小全科｜國中數學・自然",
      base
    ),

    body: b([
      sep("none"),

      t("授課方式", {
        size: "xs",
        weight: "bold",
        color: C.deep
      }),

      t("到府或線上一對一教學"),

      t("授課時間", {
        size: "xs",
        weight: "bold",
        color: C.deep,
        margin: "lg"
      }),

      t("星期一、三、四、六晚上"),

      t("授課地區", {
        size: "xs",
        weight: "bold",
        color: C.deep,
        margin: "lg"
      }),

      t("到府以天母地區為佳"),

      sep("lg"),

      t("我的教學方式", {
        weight: "bold",
        color: C.deep,
        margin: "lg"
      }),

      t("觀念理解、題意拆解、個別化練習"),

      t(
        "依學生程度調整節奏，" +
        "陪伴學生練習思考與獨立解題。",
        {
          color: C.muted,
          margin: "md"
        }
      )
    ], {
      paddingAll: "20px",
      spacing: "md",
      backgroundColor: C.white
    })
  };
}

// =====================================
// 教學成果
// =====================================

function progress(subject, from, to, gain) {
  return b([
    t(subject, {
      size: "xs",
      color: C.muted
    }),

    r([
      t(from, {
        size: "lg",
        color: "#A0AAA6",
        weight: "bold",
        flex: 0
      }),

      t("→", {
        size: "sm",
        color: C.green,
        flex: 0,
        margin: "md"
      }),

      t(to + " 分", {
        size: "xxl",
        weight: "bold",
        color: C.green,
        flex: 1,
        margin: "md"
      }),

      t("+" + gain + " 分", {
        size: "xs",
        color: C.green,
        weight: "bold",
        flex: 0
      })
    ], {
      margin: "md",
      spacing: "xs"
    })
  ], {
    spacing: "xs"
  });
}

function resultsCard(base) {
  return {
    type: "bubble",
    size: "mega",

    header: lightHeader(
      "teacher",
      "教學成果",
      "用實際進步，看見學習的改變",
      base
    ),

    body: b([
      sep("none"),

      progress("國中數學", "20", "70", 50),

      sep("lg"),

      progress("國中自然", "50", "94", 44),

      sep("lg"),

      b([
        t("其他教學成果", {
          weight: "bold",
          color: C.deep
        }),

        t("國小數學｜不及格進步至 80 分", {
          margin: "md"
        }),

        t("國小全科｜班級排名前 6", {
          margin: "sm"
        }),

        t("另有國中數學 90 分的教學案例", {
          size: "xs",
          color: C.muted,
          margin: "sm"
        })
      ], {
        backgroundColor: C.mint,
        cornerRadius: "12px",
        paddingAll: "15px",
        margin: "lg"
      })
    ], {
      paddingAll: "20px",
      spacing: "lg",
      backgroundColor: C.white
    })
  };
}

function experienceMessage(base) {
  return flexMessage(
    "教學經驗與成果",
    {
      type: "carousel",
      contents: [
        introCard(base),
        resultsCard(base)
      ]
    },
    base
  );
}

// =====================================
// 課程費用
// =====================================

function rateRow(label, amount, featured) {
  return r([
    t(label, {
      color: featured ? C.green : C.muted,
      weight: featured ? "bold" : "regular",
      flex: 1
    }),

    t(dollars(amount) + " /hr", {
      size: "lg",
      color: featured ? C.green : C.dark,
      weight: "bold",
      align: "end",
      flex: 1
    })
  ], {
    spacing: "md"
  });
}

function priceSection(name, regular, monthly, base) {
  const total = monthly * 8;
  const original = regular * 8;

  const iconName =
    name === "到府教學" ? "home" : "laptop";

  return b([
    r([
      b([
        icon(base, iconName, "30px")
      ], {
        backgroundColor: C.mint,
        cornerRadius: "10px",
        paddingAll: "8px",
        flex: 0
      }),

      t(name, {
        size: "md",
        color: C.deep,
        weight: "bold",
        flex: 1,
        margin: "md"
      })
    ]),

    rateRow("單堂計費", regular, false),

    rateRow("月收優惠", monthly, true),

    b([
      t("每堂 2 小時 × 每月 4 堂", {
        size: "xs",
        color: C.muted
      }),

      r([
        t("單堂合計 " + dollars(original), {
          size: "xs",
          color: C.muted,
          flex: 1
        }),

        t("省 " + dollars(original - total), {
          size: "xs",
          color: C.green,
          weight: "bold",
          align: "end",
          flex: 0
        })
      ], {
        margin: "md"
      }),

      sep("md"),

      t("月收總額", {
        size: "xs",
        weight: "bold",
        color: C.green,
        margin: "md"
      }),

      t(dollars(total), {
        size: "xxl",
        weight: "bold",
        color: C.green,
        margin: "xs"
      })
    ], {
      backgroundColor: C.mint,
      cornerRadius: "12px",
      paddingAll: "15px",
      spacing: "sm",
      margin: "md"
    })
  ], {
    spacing: "lg"
  });
}

function priceCard(data, base) {
  return {
    type: "bubble",
    size: "mega",

    header: lightHeader(
      "price",
      data.title + "家教課程",
      data.subtitle + "｜一對一教學",
      base
    ),

    body: b([
      sep("none"),

      priceSection(
        "到府教學",
        data.onsite[0],
        data.onsite[1],
        base
      ),

      sep("xl"),

      priceSection(
        "線上教學",
        data.online[0],
        data.online[1],
        base
      ),

      t(
        "以上依每堂 2 小時、每月 4 堂試算；" +
        "實際依授課時數及方案計算。",
        {
          size: "xs",
          color: C.muted,
          align: "center",
          margin: "xl"
        }
      )
    ], {
      paddingAll: "19px",
      spacing: "xl",
      backgroundColor: C.white
    })
  };
}

function priceMessage(base) {
  return flexMessage(
    "國中與國小家教課程費用",
    {
      type: "carousel",
      contents: [
        priceCard(PRICES.junior, base),
        priceCard(PRICES.elementary, base)
      ]
    },
    base
  );
}

// =====================================
// 上課須知
// =====================================

function rule(number, title, desc) {
  return r([
    b([
      t(number, {
        weight: "bold",
        color: C.green,
        align: "center"
      })
    ], {
      backgroundColor: C.mint,
      cornerRadius: "8px",
      paddingAll: "9px",
      flex: 0
    }),

    b([
      t(title, {
        weight: "bold",
        color: C.deep
      }),

      t(desc, {
        margin: "sm"
      })
    ], {
      flex: 1,
      margin: "md",
      spacing: "xs"
    })
  ], {
    alignItems: "flex-start"
  });
}

function policyMessage(base) {
  return flexMessage(
    "家教上課須知",
    {
      type: "bubble",
      size: "mega",

      header: lightHeader(
        "policy",
        "上課須知",
        "請假・補課・課程安排",
        base
      ),

      body: b([
        sep("none"),

        rule(
          "01",
          "提前請假",
          "最晚請於上課前一日透過 LINE 通知。" +
          "可補課或直接取消，皆不收取取消費用。"
        ),

        sep("lg"),

        rule(
          "02",
          "當日臨時請假",
          "原則上不接受當日臨時請假；" +
          "學生生病或不可抗力狀況除外，" +
          "可協調補課。"
        ),

        sep("lg"),

        rule(
          "03",
          "補課與取消",
          "補課時間由雙方協調。" +
          "月收方案當日若非因生病而直接取消，" +
          "該堂照常計費；單堂制另依事先約定。"
        ),

        sep("lg"),

        rule(
          "04",
          "遲到與老師請假",
          "學生遲到仍依原定時間下課。" +
          "老師請假會協調補課；" +
          "無法補課則退還或折抵該堂費用。"
        ),

        sep("lg"),

        t("請假或調課請直接傳訊息與老師聯繫。", {
          size: "xs",
          color: C.muted,
          margin: "lg"
        })
      ], {
        paddingAll: "19px",
        spacing: "lg",
        backgroundColor: C.white
      })
    },
    base
  );
}

// =====================================
// 台灣時間
// =====================================

function taipeiNow() {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }
  ).formatToParts(new Date());

  const get = key =>
    parts.find(p => p.type === key)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`
  };
}

// =====================================
// Firestore 公開空堂讀取
// =====================================

const defaultProject = PROJECT_ID;

async function readTeacherAvailabilityDocument(env, fetchDocument = fetch) {
  const teacherUid = env?.TEACHER_UID;
  if (typeof teacherUid !== 'string' || !/^[^/\s]{1,128}$/.test(teacherUid) || /^(__.*__|\.{1,2})$/.test(teacherUid)) {
    throw new Error('TEACHER_UID is missing or invalid');
  }
  const project = env.FIREBASE_PROJECT_ID || defaultProject;
  const database = env.FIRESTORE_DATABASE_ID || '(default)';
  const root = 'https://firestore.googleapis.com/v1/projects/';
  const url = root + encodeURIComponent(project) + '/databases/' + encodeURIComponent(database) +
    '/documents/teachers/' + encodeURIComponent(teacherUid) + '/public/publicAvailability';
  const response = await fetchDocument(url, {cache: 'no-store'});
  if (!response.ok) throw new Error('Firestore ' + response.status);
  const document = await response.json();
  const arrayValue = document.fields?.slots?.arrayValue;
  if (!arrayValue || !Array.isArray(arrayValue.values ?? [])) {
    throw new Error('Firestore public availability document is missing its slots array');
  }
  return arrayValue.values ?? [];
}

function selectTeacherAvailability(rows, now) {
  const slots = [];
  for (const row of rows) {
    const f = row.mapValue?.fields || {};
    const date = f.date?.stringValue;
    const start = f.start?.stringValue;
    const end = f.end?.stringValue;
    const status = f.status?.stringValue;
    if (status !== 'available' || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') ||
        !/^\d{2}:\d{2}$/.test(start || '') || !/^\d{2}:\d{2}$/.test(end || '') ||
        end <= start || date < now.date || (date === now.date && end <= now.time)) continue;
    slots.push({date, start, end});
  }
  return slots.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

async function availability(env) {
  const now = taipeiNow();
  const rows = await readTeacherAvailabilityDocument(env);
  return selectTeacherAvailability(rows, now);
}

// =====================================
// 預約訊息連結
// =====================================

function bookingUrl(oaId, slot) {
  const message = [
    "您好，我想詢問家教預約。",
    "",
    `日期：${slot.date}`,
    `時間：${slot.start}–${slot.end}`,
    "",
    "學生年級：",
    "科目：",
    "上課地點：",
    "",
    "請問這個時段還可以預約嗎？謝謝！"
  ].join("\n");

  return (
    "https://line.me/R/oaMessage/" +
    `${encodeURIComponent(oaId)}/?` +
    `${encodeURIComponent(message)}`
  );
}

// =====================================
// 空堂卡片
// =====================================

function calendarCard(date, slots, oaId, base) {
  const [y, m, d] = date.split("-").map(Number);

  const weekdays = [
    "日", "一", "二", "三",
    "四", "五", "六"
  ];

  const weekday = weekdays[
    new Date(Date.UTC(y, m - 1, d))
      .getUTCDay()
  ];

  const visible = slots.slice(
    0,
    MAX_TIMES_PER_DAY
  );

  const buttons = visible.map(slot => ({
    type: "button",
    style: "secondary",
    height: "sm",
    color: C.mint,
    margin: "md",

    action: {
      type: "uri",
      label: `${slot.start}–${slot.end}`,
      uri: bookingUrl(oaId, slot)
    }
  }));

  const extra = slots.length - visible.length;

  return {
    type: "bubble",
    size: "kilo",

    header: lightHeader(
      "calendar",
      `${m}/${d}　星期${weekday}`,
      "可預約上課時段",
      base
    ),

    body: b([
      t("請選擇適合的時段", {
        color: C.muted
      }),

      ...buttons,

      ...(extra > 0
        ? [
            t(
              `另外還有 ${extra} 個時段，歡迎私訊詢問`,
              {
                size: "xs",
                color: C.muted,
                margin: "md"
              }
            )
          ]
        : []
      ),

      sep("lg"),

      t(
        "點擊時段後，請填寫學生年級、" +
        "科目、上課地點，再送出訊息。",
        {
          size: "xs",
          color: C.muted,
          margin: "lg"
        }
      )
    ], {
      paddingAll: "17px",
      spacing: "md"
    })
  };
}

function calendarMessage(slots, oaId, base) {
  const grouped = new Map();

  for (const slot of slots) {
    if (!grouped.has(slot.date)) {
      grouped.set(slot.date, []);
    }

    grouped.get(slot.date).push(slot);
  }

  return flexMessage(
    "家教可預約時段",
    {
      type: "carousel",
      contents: [...grouped.keys()]
        .sort()
        .slice(0, MAX_DAYS)
        .map(date =>
          calendarCard(
            date,
            grouped.get(date),
            oaId,
            base
          )
        )
    },
    base
  );
}

// =====================================
// 指令辨識
// =====================================

function command(event) {
  if (event.type === "postback") {
    const commands = {
      menu_open: "查看選單",
      menu_experience: "教學經驗",
      menu_price: "課程費用",
      menu_availability: "詢問時段",
      menu_policy: "上課須知"
    };

    return commands[event.postback?.data] || "";
  }

  if (
    event.type === "message" &&
    event.message?.type === "text"
  ) {
    return String(
      event.message.text || ""
    ).trim();
  }

  return "";
}

// =====================================
// 純文字備援
// =====================================

function fallbackPrice() {
  return (
    "家教課程費用\n\n" +

    "【國中】\n" +
    "到府：單堂 $700/hr，月收 $650/hr\n" +
    "線上：單堂 $600/hr，月收 $500/hr\n" +
    "月收試算：到府 $5,200，線上 $4,000\n\n" +

    "【國小】\n" +
    "到府：單堂 $600/hr，月收 $550/hr\n" +
    "線上：單堂 $500/hr，月收 $400/hr\n" +
    "月收試算：到府 $4,400，線上 $3,200\n\n" +

    "以每堂 2 小時、每月 4 堂計算。"
  );
}

// =====================================
// LINE Webhook 處理
// =====================================

async function handleEvent(event, env, base) {
  if (!event?.replyToken) return;

  let message = null;
  let fallback = "";

  if (event.type === "follow") {
    message = welcome(base);
  }

  else if (
    event.type === "postback" ||
    (
      event.type === "message" &&
      event.message?.type === "text"
    )
  ) {
    const input = command(event);

    // 單一圖文選單的 Postback
    if (input === "查看選單") {
      message = welcome(base);
    }

    else if (input === "教學經驗") {
      message = experienceMessage(base);

      fallback =
        "教學經驗：國小全科、國中數學與自然。" +
        "國中數學 20→70，國中自然 50→94，" +
        "國小數學不及格→80，" +
        "國小全科班排前六。";
    }

    else if (input === "課程費用") {
      message = priceMessage(base);
      fallback = fallbackPrice();
    }

    else if (
      [
        "上課須知",
        "請假規範",
        "補課規範"
      ].includes(input)
    ) {
      message = policyMessage(base);

      fallback =
        "上課須知：最晚前一天請假，" +
        "可補課或取消；" +
        "當日非因生病取消，" +
        "月收方案照常計費；" +
        "學生遲到不順延。";
    }

    else if (
      [
        "詢問時段",
        "諮詢時間",
        "詢問可預約時間",
        "可預約時間",
        "查看空堂",
        "預約時間"
      ].includes(input)
    ) {
      try {
        const oaId = String(
          env.LINE_OA_ID || ""
        ).trim();

        if (!/^@[A-Za-z0-9._-]+$/.test(oaId)) {
          throw new Error(
            "LINE_OA_ID incorrect"
          );
        }

        const slots = await availability(env);

        message = slots.length
          ? calendarMessage(slots, oaId, base)
          : textMessage(
              "目前沒有開放的預約時段，" +
              "請直接私訊老師。",
              base
            );

        fallback =
          "目前無法顯示預約卡片，" +
          "請直接私訊老師詢問空堂。";
      } catch (err) {
        console.error("Availability error", err);

        message = textMessage(
          "目前無法讀取最新空堂，" +
          "請直接私訊老師。",
          base
        );
      }
    }

    // 舊版文字指令保留相容
    else if (
      [
        "選單",
        "menu",
        "你好",
        "您好",
        "嗨",
        "hi"
      ].includes(input.toLowerCase())
    ) {
      message = welcome(base);
    }

    // 一般私訊留給真人老師
    else {
      return;
    }
  }

  else {
    return;
  }

  if (!message) return;

  // 驗證 Flex 訊息
  if (message.type === "flex") {
    try {
      const validation = await fetch(
        "https://api.line.me/v2/bot/message/validate/reply",
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messages: [message]
          })
        }
      );

      if (!validation.ok) {
        console.error(
          "Flex validation failed",
          await validation.text()
        );

        message = textMessage(
          fallback ||
          "卡片暫時無法顯示，請私訊老師。",
          base
        );
      }
    } catch (err) {
      console.error("Validation error", err);
    }
  }

  // 回覆訊息
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        replyToken: event.replyToken,
        messages: [message]
      })
    }
  );

  if (!response.ok) {
    console.error(
      "LINE reply failed",
      response.status,
      await response.text()
    );
  }
}

// =====================================
// Rich Menu 管理頁
// =====================================

function adminPage() {
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>TutorFlow 圖文選單管理</title>
<style>
:root{
  font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;
  color-scheme:light;
}
*{box-sizing:border-box}
body{
  background:#f5f8f5;
  margin:0;
  padding:24px 14px;
  color:#273b45;
}
main{
  max-width:560px;
  margin:35px auto;
  background:white;
  border:1px solid #e5ece7;
  border-radius:20px;
  padding:30px;
  box-shadow:0 12px 40px #15554210;
}
h1{
  font-size:23px;
  color:#155542;
  margin:0 0 10px;
}
p{
  font-size:14px;
  color:#687889;
  line-height:1.8;
}
label{
  display:block;
  font-size:14px;
  font-weight:600;
  margin:22px 0 9px;
}
input{
  display:block;
  width:100%;
  padding:13px;
  border:1px solid #c8d7cd;
  border-radius:10px;
  font-size:15px;
}
button{
  width:100%;
  margin-top:25px;
  padding:15px;
  border:0;
  border-radius:10px;
  background:#176b53;
  color:white;
  font-size:15px;
  font-weight:600;
  cursor:pointer;
}
button:disabled{
  opacity:.55;
}
.hint{
  font-size:12px;
}
pre{
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  padding:15px;
  background:#eaf4ed;
  border-radius:10px;
  font-size:13px;
  line-height:1.7;
}
.error{
  background:#fff0ee;
  color:#9c302a;
}
</style>
</head>
<body>
<main>
<h1>圖文選單管理</h1>

<p>
沿用你原本的「查看選單」圖片。
家長點擊後由 Worker 回覆四個 Quick Reply，
不需要傳送「選單」聊天文字。
</p>

<form id="form">

<label for="secret">管理員密鑰</label>
<input
  id="secret"
  type="password"
  autocomplete="off"
  placeholder="RICHMENU_ADMIN_KEY"
  required
>

<label for="file">圖文選單圖片</label>
<input
  id="file"
  type="file"
  accept="image/png"
  required
>

<p class="hint">
請上傳 PNG 圖片，最大 1 MB。
寬度 800～2500 px，高度至少 250 px。
</p>

<button id="submit" type="submit">
上傳並啟用圖文選單
</button>

</form>

<p class="hint">
只有按下上傳並啟用後，才會修改 LINE 的預設圖文選單。
請勿將管理密鑰分享給其他人。
</p>

<pre id="result" role="status" hidden></pre>

</main>

<script>
const form = document.getElementById("form");
const output = document.getElementById("result");
const button = document.getElementById("submit");

form.addEventListener("submit", async event => {
  event.preventDefault();

  const file = document.getElementById("file").files[0];
  const secret = document.getElementById("secret").value;

  if (!file) return;

  output.hidden = false;

  if (file.size > 1048576) {
    output.className = "error";
    output.textContent = "圖片超過 1 MB";
    return;
  }

  button.disabled = true;
  output.className = "";
  output.textContent = "正在建立並上傳圖文選單...";

  try {
    const formData = new FormData();

    formData.append(
      "image",
      file,
      file.name
    );

    const response = await fetch(
      "/admin/richmenu/install",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret
        },
        body: formData,
        cache: "no-store"
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || "上傳失敗"
      );
    }

    output.textContent =
      "圖文選單已成功啟用！\\n" +
      "Rich Menu ID：" + result.richMenuId +
      "\\n請重新開啟 LINE 聊天室測試。";

  } catch (err) {
    output.className = "error";
    output.textContent =
      "設定失敗：" + err.message;

  } finally {
    button.disabled = false;
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

// =====================================
// 管理密鑰驗證
// =====================================

async function verifyAdmin(request, expected) {
  const token = (
    request.headers.get("authorization") || ""
  ).replace(/^Bearer\s+/i, "");

  if (!expected || !token || token.length > 512) {
    return false;
  }

  const encoder = new TextEncoder();

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

  let difference = 0;

  for (let i = 0; i < x.length; i++) {
    difference |= x[i] ^ y[i];
  }

  return difference === 0;
}

// =====================================
// JSON 回覆
// =====================================

function jsonReply(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    }
  );
}

// =====================================
// LINE 管理 API
// =====================================

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
        Authorization: "Bearer " + token,
        ...(options.headers || {})
      }
    }
  );

  if (!response.ok) {
    const error = (
      await response.text()
    ).slice(0, 600);

    throw new Error(
      "LINE API " +
      response.status +
      ": " +
      error
    );
  }

  if (response.status === 204) {
    return {};
  }

  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// =====================================
// 安裝單一圖文選單
// =====================================

async function installRichMenu(request, env) {
  if (!env.RICHMENU_ADMIN_KEY) {
    return jsonReply({
      error:
        "尚未設定 RICHMENU_ADMIN_KEY Secret"
    }, 503);
  }

  const authorized = await verifyAdmin(
    request,
    env.RICHMENU_ADMIN_KEY
  );

  if (!authorized) {
    return jsonReply({
      error: "管理密鑰錯誤"
    }, 401);
  }

  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return jsonReply({
      error: "缺少 LINE_CHANNEL_ACCESS_TOKEN"
    }, 503);
  }

  const contentType =
    request.headers.get("content-type") || "";

  if (!contentType.startsWith("multipart/form-data")) {
    return jsonReply({
      error: "請從管理頁上傳 PNG 圖片"
    }, 415);
  }

  const contentLength = Number(
    request.headers.get("content-length") || 0
  );

  if (contentLength > 1400000) {
    return jsonReply({
      error: "上傳內容過大"
    }, 413);
  }

  let file;

  try {
    const form = await request.formData();
    file = form.get("image");
  } catch {
    return jsonReply({
      error: "圖片上傳格式錯誤"
    }, 400);
  }

  if (
    !file ||
    typeof file.arrayBuffer !== "function"
  ) {
    return jsonReply({
      error: "請先選擇圖片"
    }, 400);
  }

  if (
    file.size < 24 ||
    file.size > 1048576
  ) {
    return jsonReply({
      error: "圖片必須小於 1 MB"
    }, 400);
  }

  const bytes = new Uint8Array(
    await file.arrayBuffer()
  );

  // 驗證 PNG 簽章
  const pngSignature = [
    137, 80, 78, 71,
    13, 10, 26, 10
  ];

  const validPNG =
    pngSignature.every(
      (value, i) => bytes[i] === value
    ) &&
    String.fromCharCode(
      ...bytes.slice(12, 16)
    ) === "IHDR";

  if (!validPNG) {
    return jsonReply({
      error: "圖片必須是 PNG 格式"
    }, 400);
  }

  // 讀取 PNG 寬高
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const width = view.getUint32(16);
  const height = view.getUint32(20);

  if (
    width < 800 ||
    width > 2500 ||
    height < 250 ||
    width / height < 1.45
  ) {
    return jsonReply({
      error:
        "圖片尺寸不符合 LINE 圖文選單規格。" +
        "寬度需 800～2500 px，" +
        "高度至少 250 px，" +
        "寬高比至少 1.45。"
    }, 400);
  }

  // 整張圖片都是單一查看選單按鈕
  const richMenu = {
    size: {
      width,
      height
    },

    selected: true,

    name: "TutorFlow 單一查看選單",

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
          inputOption: "closeRichMenu"
        }
      }
    ]
  };

  const token = env.LINE_CHANNEL_ACCESS_TOKEN;

  let richMenuId = null;
  let installed = false;

  try {
    // 1. 驗證 Rich Menu JSON
    await lineAdminFetch(
      "/v2/bot/richmenu/validate",
      token,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(richMenu)
      }
    );

    // 2. 建立圖文選單
    const created = await lineAdminFetch(
      "/v2/bot/richmenu",
      token,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(richMenu)
      }
    );

    richMenuId = created.richMenuId;

    if (
      !richMenuId ||
      !/^richmenu-[A-Za-z0-9]+$/.test(richMenuId)
    ) {
      throw new Error(
        "LINE 沒有回傳有效 richMenuId"
      );
    }

    // 3. 上傳 PNG 至 LINE
    await lineAdminFetch(
      "/v2/bot/richmenu/" +
      richMenuId +
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

    // 4. 設定所有好友的預設選單
    await lineAdminFetch(
      "/v2/bot/user/all/richmenu/" +
      richMenuId,
      token,
      {
        method: "POST"
      }
    );

    installed = true;

    return jsonReply({
      ok: true,
      richMenuId
    });

  } catch (error) {
    console.error(
      "Rich Menu setup failed",
      error
    );

    // 失敗時清除尚未啟用的新選單
    if (richMenuId && !installed) {
      try {
        await lineAdminFetch(
          "/v2/bot/richmenu/" + richMenuId,
          token,
          {
            method: "DELETE"
          }
        );
      } catch (cleanupError) {
        console.error(
          "Cleanup failed",
          cleanupError
        );
      }
    }

    return jsonReply({
      error: String(
        error.message || error
      )
    }, 502);
  }
}
