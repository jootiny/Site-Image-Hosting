import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { fetchSecurityConfig } from "../utils/sysConfig";
import { TelegramAPI } from "../utils/telegramAPI";
import {
  setCommonHeaders,
  setRangeHeaders,
  handleHeadRequest,
  getFileContent,
  returnWithCheck,
  returnBlockImg,
  return404,
  isDomainAllowed,
} from "./fileTools";

export async function onRequest(context) {
  const {
    request, // same as existing Worker API
    env, // same as existing Worker API
    params, // if filename includes [id] or [[path]]
    waitUntil, // same as ctx.waitUntil in existing Worker API
    next, // used for middleware or to fetch assets
    data, // arbitrary space for passing data between middlewares
  } = context;

  // 1. 解码文件ID
  let fileId = "";
  try {
    params.path = decodeURIComponent(params.path);
    fileId = params.path.split(",").join("/");
  } catch (e) {
    return new Response("Error: Decode Image ID Failed", { status: 400 });
  }

  // 2. 解析安全配置
  context.securityConfig = await fetchSecurityConfig(env);
  context.url = new URL(request.url);
  context.Referer = request.headers.get("Referer");

  // 3. 检查引用域名合法性
  if (!isDomainAllowed(context)) return await returnBlockImg(context.url);

  // 4. 获取KV图片记录
  const imgRecord = await env.img_url.getWithMetadata(fileId);
  if (!imgRecord) return new Response("Error: Image Not Found", { status: 404 });

  const { FileName, FileType, Channel } = imgRecord.metadata;
  const encodedFileName = encodeURIComponent(FileName || fileId);

  // 5. 检查访问权限
  const accessRes = await returnWithCheck(context, imgRecord);
  if (accessRes.status !== 200) return accessRes; // 如果不可访问，直接返回

  // 6. 根据渠道处理
  switch (Channel) {
    case "CloudflareR2" /* Cloudflare R2渠道 */:
      return await handleR2File(context, fileId, encodedFileName, FileType);

    case "S3" /* S3渠道 */:
      return await handleS3File(context, imgRecord.metadata, encodedFileName, FileType);

    case "External" /* 外链渠道 */:
      return Response.redirect(imgRecord.metadata.ExternalLink, 302);

    case "TelegramNew" /* Telegram */:
      if (imgRecord.metadata.IsChunked) {
        return handleTelegramChunkedFile(context, imgRecord, encodedFileName, FileType);
      }
      return handleTelegramFile(context, imgRecord, encodedFileName, FileType);

    default: /* 渠道错误，返回报错 */
      return new Response("Error: Invalid Channel", { status: 500 });
  }
}

/** 处理 Telegram 普通文件 */
async function handleTelegramFile(context, imgRecord, encodedFileName, fileType) {
  const { env, request, url, Referer } = context;
  const TgFileID = imgRecord.metadata.TgFileId;
  const TgBotToken = imgRecord.metadata.TgBotToken || env.TG_BOT_TOKEN;
  // 获取TG图片真实地址
  const tgApi = new TelegramAPI(TgBotToken);
  const filePath = await tgApi.getFilePath(TgFileID);
  if (!filePath) return new Response("Error: Failed to fetch image path", { status: 500 });

  const targetUrl = `https://api.telegram.org/file/bot${TgBotToken}/${filePath}`;

  try {
    const response = await getFileContent(request, targetUrl);
    if (!response) return new Response("Error: Failed to fetch image", { status: 500 });
    if (response.status === 404) return await return404(url);

    const headers = new Headers(response.headers);
    setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    return new Response("Error: " + error, { status: 500 });
  }
}

/** 处理 Telegram 分片文件 */
async function handleTelegramChunkedFile(context, imgRecord, encodedFileName, fileType) {
  const { env, request, url, Referer } = context;
  const metadata = imgRecord.metadata;
  const TgBotToken = metadata.TgBotToken || env.TG_BOT_TOKEN;

  // 解析分片信息并排序
  let chunks = [];
  try {
    if (imgRecord.value) {
      chunks = JSON.parse(imgRecord.value);
      chunks.sort((a, b) => a.index - b.index);
    }
  } catch (parseError) {
    console.error("Failed to parse chunks data:", parseError);
    return new Response("Error: Invalid chunks data", { status: 500 });
  }

  if (chunks.length === 0) return new Response("Error: No chunks found for this file", { status: 500 });

  // 验证分片完整性
  const expectedChunks = metadata.TotalChunks || chunks.length;
  if (chunks.length !== expectedChunks) {
    return new Response(`Error: Missing chunks, expected ${expectedChunks}, got ${chunks.length}`, { status: 500 });
  }

  // 计算文件总大小
  const totalSize = chunks.reduce((total, chunk) => total + (chunk.size || 0), 0);

  // 构建响应头
  const headers = new Headers();
  setCommonHeaders(headers, encodedFileName, fileType, Referer, url);
  headers.set("Content-Length", totalSize.toString());
  const etag = `"${metadata.TimeStamp || Date.now()}-${totalSize}"`;
  headers.set("ETag", etag);

  // 检查If-None-Match头（304缓存）
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": headers.get("Cache-Control"),
        "Accept-Ranges": "bytes",
      },
    });
  }

  // 检查Range请求头
  const range = request.headers.get("Range");
  let rangeStart = 0;
  let rangeEnd = totalSize - 1;
  let isRangeRequest = false;
  if (range) {
    const matches = range.match(/bytes=(\d+)-(\d*)/);
    if (matches) {
      rangeStart = parseInt(matches[1]);
      rangeEnd = matches[2] ? parseInt(matches[2]) : totalSize - 1;
      isRangeRequest = true;

      // 验证范围有效性
      if (rangeStart >= totalSize || rangeEnd >= totalSize || rangeStart > rangeEnd) {
        return new Response("Range Not Satisfiable", { status: 416 });
      }
    }
  }

  // 处理HEAD请求
  if (request.method === "HEAD") return handleHeadRequest(headers, etag);

  // 创建支持Range请求的流
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let currentPosition = 0;
        for (const chunk of chunks) {
          const chunkSize = chunk.size || 0;

          // 跳过当前分片前面的范围
          if (currentPosition + chunkSize <= rangeStart) {
            currentPosition += chunkSize;
            continue;
          }

          // 如果当前分片完全在请求范围之后，结束
          if (currentPosition > rangeEnd) break;

          // 获取分片数据
          const chunkData = await fetchTelegramChunkWithRetry(TgBotToken, chunk, 3);
          if (!chunkData) throw new Error(`Failed to fetch chunk ${chunk.index} after retries`);

          // 计算在当前分片中的起始和结束位置
          const chunkStart = Math.max(0, rangeStart - currentPosition);
          const chunkEnd = Math.min(chunkSize, rangeEnd - currentPosition + 1);

          // 如果需要部分分片数据
          if (chunkStart > 0 || chunkEnd < chunkSize) {
            const partialData = chunkData.slice(chunkStart, chunkEnd);
            controller.enqueue(partialData);
          } else {
            controller.enqueue(chunkData);
          }

          currentPosition += chunkSize;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  try {
    if (isRangeRequest) setRangeHeaders(headers, rangeStart, rangeEnd, totalSize);
    return new Response(stream, {
      status: isRangeRequest ? 206 : 200,
      headers,
    });
  } catch (error) {
    return new Response(`Error: Failed to reconstruct chunked file - ${error.message}`, { status: 500 });
  }
}

/** 带重试机制获取 Telegram 分片 */
async function fetchTelegramChunkWithRetry(botToken, chunk, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const tgApi = new TelegramAPI(botToken);
      const response = await tgApi.getFileContent(chunk.fileId);

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      // 验证分片大小是否匹配
      const chunkData = await response.arrayBuffer();
      const actualSize = chunkData.byteLength;

      // 如果有期望大小且不匹配，抛出错误
      if (chunk.size && actualSize !== chunk.size) {
        console.warn(`Chunk ${chunk.index} size mismatch: expected ${chunk.size}, got ${actualSize}`);
      }
      return new Uint8Array(chunkData);
    } catch (error) {
      console.warn(`Chunk ${chunk.index} fetch attempt ${attempt + 1} failed:`, error.message);
      if (attempt === maxRetries - 1) return null;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  return null;
}

/** 处理R2文件读取 */
async function handleR2File(context, fileId, encodedFileName, fileType) {
  const { env, request, url, Referer } = context;

  // 检查是否配置了R2
  if (!env.img_r2) {
    return new Response("Error: Please configure R2 database", { status: 500 });
  }

  try {
    const R2DataBase = env.img_r2;
    const range = request.headers.get("Range");
    let object;

    // Range请求处理
    if (range) {
      const matches = range.match(/bytes=(\d+)-(\d*)/);
      if (matches) {
        const start = parseInt(matches[1]);
        const end = matches[2] ? parseInt(matches[2]) : undefined;
        const rangeOptions = { range: { offset: start } };
        if (end !== undefined && end >= start) rangeOptions.range.length = end - start + 1;
        object = await R2DataBase.get(fileId, rangeOptions);
      } else {
        object = await R2DataBase.get(fileId);
      }
    } else {
      object = await R2DataBase.get(fileId);
    }

    if (object === null) return new Response("Error: Failed to fetch file", { status: 500 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

    // 处理HEAD请求
    if (request.method === "HEAD") return handleHeadRequest(headers);

    // 如果是Range请求，设置相应的状态码和头
    if (range && object.range) {
      headers.set(
        "Content-Range",
        `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`
      );
      headers.set("Content-Length", object.range.length.toString());
      return new Response(object.body, { status: 206, headers });
    } else {
      return new Response(object.body, { status: 200, headers });
    }
  } catch (error) {
    return new Response(`Error: Failed to fetch from R2 - ${error.message}`, { status: 500 });
  }
}

/** 处理S3文件读取 */
async function handleS3File(context, metadata, encodedFileName, fileType) {
  const { Referer, url, request } = context;

  const s3Client = new S3Client({
    region: metadata?.S3Region || "auto",
    endpoint: metadata?.S3Endpoint,
    credentials: {
      accessKeyId: metadata?.S3AccessKeyId,
      secretAccessKey: metadata?.S3SecretAccessKey,
    },
    forcePathStyle: metadata?.S3PathStyle || false,
  });

  // 检查Range请求头
  try {
    const rangeHeader = request.headers.get("Range");
    const commandParams = {
      Bucket: metadata?.S3BucketName,
      Key: metadata?.S3FileKey,
      Range: rangeHeader || undefined,
    };

    const command = new GetObjectCommand(commandParams);
    const response = await s3Client.send(command);

    // 设置响应头
    const headers = new Headers();
    setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

    // 设置Content-Length和Content-Range头
    if (response.ContentLength) headers.set("Content-Length", response.ContentLength.toString());

    if (response.ContentRange) headers.set("Content-Range", response.ContentRange);

    // 处理HEAD请求
    if (request.method === "HEAD") return handleHeadRequest(headers);

    // 返回响应，支持流式传输
    return new Response(response.Body, { status: rangeHeader ? 206 : 200, headers });
  } catch (error) {
    return new Response(`Error: Failed to fetch from S3 - ${error.message}`, { status: 500 });
  }
}
