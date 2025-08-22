const apis = {
  random: getRandomWallpaper, // 随机壁纸，从其他壁纸源随机获取
  bing: getBingWallpaper, // Bing壁纸
  yinghua: getYingHuaWallpaper, // 樱花壁纸
  "alcy-2cy": getAlcy2cyWallpaper, // 栗次元，二次元
  "alcy-ai": getAlcyAIWallpaper, // 栗次元，AI壁纸
  "alcy-genshin": getAlcyGenShinWallpaper, // 栗次元，原神壁纸
  "likepoems-2cy": getLikePoems2cyWallpaper, // 如诗壁纸，二次元
  "likepoems-nature": getLikePoemsNatureWallpaper, // 如诗壁纸，自然风景
  "suyan-nature": getSuYanNatureWallpaper, // 素颜壁纸，自然风景
  "suyan-genshin": getSuYanGenshinWallpaper, // 素颜壁纸，原神
};

// 获取 Bing 壁纸
async function getBingWallpaper(num = 1) {
  const wallpapers = [];
  await fetch(`https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=${num}`)
    .then((res) => res.json())
    .then((data) => {
      data.images.forEach((img) => {
        wallpapers.push({
          url: `https://cn.bing.com${img.url}`,
          meta: { source: "Bing壁纸", title: img.title },
        });
      });
    });
  return wallpapers;
}

// 获取樱花壁纸
async function getYingHuaWallpaper(num = 1) {
  const wallpapers = [];
  for (let i = 0; i < num; i++) {
    await fetch(`https://www.dmoe.cc/random.php?return=json`)
      .then((res) => res.json())
      .then((data) => {
        wallpapers.push({
          url: data.imgurl,
          meta: { source: "樱花壁纸", width: data.width, height: data.height },
        });
      });
  }
  return wallpapers;
}

// 获取栗次元壁纸
async function getAlcy2cyWallpaper(num = 1) {
  const wallpapers = [];
  await fetch(`https://t.alcy.cc/ycy?json&quantity=${num}`)
    .then((res) => res.text())
    .then((data) => {
      data.split("\n").forEach((img) => {
        img = img.trim();
        wallpapers.push({
          url: img,
          meta: { source: "栗次元-二次元" },
        });
      });
    });
  return wallpapers;
}

async function getAlcyAIWallpaper(num = 1) {
  const wallpapers = [];
  await fetch(`https://t.alcy.cc/ai?json&quantity=${num}`)
    .then((res) => res.text())
    .then((data) => {
      data.split("\n").forEach((img) => {
        img = img.trim();
        wallpapers.push({
          url: img,
          meta: { source: "栗次元-AI" },
        });
      });
    });
  return wallpapers;
}

async function getAlcyGenShinWallpaper(num = 1) {
  const wallpapers = [];
  await fetch(`https://t.alcy.cc/ysz?json&quantity=${num}`)
    .then((res) => res.text())
    .then((data) => {
      data.split("\n").forEach((img) => {
        img = img.trim();
        wallpapers.push({
          url: img,
          meta: { source: "栗次元-原神" },
        });
      });
    });
  return wallpapers;
}

// 获取如诗壁纸
async function getLikePoems2cyWallpaper(num = 1) {
  const wallpapers = [];
  for (let i = 0; i < num; i++) {
    await fetch(`https://api.likepoems.com/img/pc/?json`)
      .then((res) => res.json())
      .then((data) => {
        wallpapers.push({
          url: data.url,
          meta: { source: "如诗壁纸-二次元" },
        });
      });
  }
  return wallpapers;
}

async function getLikePoemsNatureWallpaper(num = 1) {
  const wallpapers = [];
  for (let i = 0; i < num; i++) {
    await fetch(`https://api.likepoems.com/img/nature/?json`)
      .then((res) => res.json())
      .then((data) => {
        wallpapers.push({
          url: data.url,
          meta: { source: "如诗壁纸-自然风景" },
        });
      });
  }
  return wallpapers;
}

// 获取素颜壁纸
async function getSuYanNatureWallpaper(num = 1) {
  const wallpapers = [];
  for (let i = 0; i < num; i++) {
    await fetch(`https://api.suyanw.cn/api/scenery.php?return=json`)
      .then((res) => res.json())
      .then((data) => {
        wallpapers.push({
          url: data.imgurl,
          meta: {
            source: "素颜壁纸-自然风景",
            width: data.width,
            height: data.height,
          },
        });
      });
  }
  return wallpapers;
}

async function getSuYanGenshinWallpaper(num = 1) {
  const wallpapers = [];
  for (let i = 0; i < num; i++) {
    wallpapers.push({
      url: "https://api.suyanw.cn/api/ys.php", // 这个接口返回图片数据本身
      meta: { source: "素颜壁纸-原神" },
    });
  }
  return wallpapers;
}

// 获取随机壁纸
async function getRandomWallpaper(num = 1) {
  const sources = Object.keys(apis).filter((key) => key !== "random");
  const len = sources.length;

  const record = {};
  sources.forEach((key) => (record[key] = 0));

  // 随机分配
  for (let i = 0; i < num; i++) {
    const randomIndex = Math.floor(Math.random() * len);
    const apiKey = sources[randomIndex];
    record[apiKey]++;
  }

  // 根据分配结果调用各个 API
  const promises = Object.keys(record)
    .filter((key) => record[key] > 0)
    .map((key) => apis[key](record[key]));
  const results = await Promise.allSettled(promises);

  return results.flat();
}

// 入口函数
export async function onRequest(context) {
  // Contents of context object
  const {
    request, // same as existing Worker API
    env, // same as existing Worker API
    params, // if filename includes [id] or [[path]]
    waitUntil, // same as ctx.waitUntil in existing Worker API
    next, // used for middleware or to fetch assets
    data, // arbitrary space for passing data between middlewares
  } = context;
  const type = new URL(request.url).searchParams.get("type") || "bing";
  const num = new URL(request.url).searchParams.get("num") || 1;
  const images = await apis[type](num);

  const return_data = {
    status: true,
    message: "操作成功",
    data: images,
  };
  const info = JSON.stringify(return_data);
  return new Response(info);
}
