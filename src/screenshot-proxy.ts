import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import {
  getErrorMessage,
  resolvePublicHttpUrl,
  type ResolvedPublicHttpUrl,
} from "./network.js";

const PROXY_CONNECT_TIMEOUT_MS = 5_000;
const LOOPBACK_HOST = "127.0.0.1";

type ResolvedAddress = ResolvedPublicHttpUrl["addresses"][number];

export interface ScreenshotTransportProxy {
  url: string;
  close(): Promise<void>;
}

function createPinnedLookup(addresses: readonly ResolvedAddress[]): net.LookupFunction {
  const pinned = addresses.map((record) => ({ ...record }));
  return (_hostname, options, callback): void => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates = requestedFamily
      ? pinned.filter((record) => record.family === requestedFamily)
      : pinned;
    if (candidates.length === 0) {
      const error = new Error("No validated address is available for the requested IP family") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, []);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[0];
    callback(null, selected.address, selected.family);
  };
}

async function connectPinnedTcp(
  addresses: readonly ResolvedAddress[],
  port: number,
): Promise<net.Socket> {
  let lastError: unknown;
  for (const record of addresses) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect({
          host: record.address,
          port,
          family: record.family === 6 ? 6 : 4,
        });
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          socket.off("error", onError);
          if (error) {
            socket.destroy();
            reject(error);
          } else {
            resolve(socket);
          }
        };
        const onError = (error: Error): void => finish(error);
        timer = setTimeout(
          () => finish(new Error("Pinned screenshot proxy connection timed out")),
          PROXY_CONNECT_TIMEOUT_MS,
        );
        socket.once("error", onError);
        socket.once("connect", () => finish());
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No validated address was available for the screenshot proxy connection");
}

function sendProxyFailure(response: http.ServerResponse): void {
  if (!response.headersSent) {
    response.writeHead(502, {
      Connection: "close",
      "Content-Length": "0",
    });
  }
  response.end();
}

function sendTunnelFailure(socket: net.Socket): void {
  if (socket.destroyed) return;
  socket.end(
    "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}

function proxyRequestUrl(request: http.IncomingMessage): string {
  const requestUrl = request.url?.trim();
  if (!requestUrl) {
    throw new Error("Blocked empty screenshot proxy request URL");
  }
  if (/^https?:\/\//i.test(requestUrl)) {
    return requestUrl;
  }
  const host = request.headers.host?.trim();
  if (!host) {
    throw new Error("Blocked screenshot proxy request without a Host header");
  }
  return `http://${host}${requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`}`;
}

async function forwardHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  onBlocked: (message: string) => void,
): Promise<void> {
  let target: ResolvedPublicHttpUrl;
  try {
    target = await resolvePublicHttpUrl(proxyRequestUrl(request));
  } catch (error) {
    onBlocked(getErrorMessage(error));
    sendProxyFailure(response);
    return;
  }

  const headers: http.OutgoingHttpHeaders = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  headers.host = target.url.host;

  const handleResponse = (upstreamResponse: http.IncomingMessage): void => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  };
  const requestOptions: http.RequestOptions = {
    hostname: target.url.hostname,
    port: target.url.protocol === "https:" ? 443 : 80,
    method: request.method,
    path: `${target.url.pathname}${target.url.search}`,
    headers,
    lookup: createPinnedLookup(target.addresses),
    agent: false,
  };
  let upstreamRequest: http.ClientRequest;
  if (target.url.protocol === "https:") {
    const httpsOptions: https.RequestOptions = {
      ...requestOptions,
      servername: target.url.hostname,
    };
    upstreamRequest = https.request(httpsOptions, handleResponse);
  } else {
    upstreamRequest = http.request(requestOptions, handleResponse);
  }

  upstreamRequest.once("error", () => sendProxyFailure(response));
  request.once("aborted", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

async function forwardConnect(
  request: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  onBlocked: (message: string) => void,
  trackUpstream: (socket: net.Socket) => void,
): Promise<void> {
  const authority = request.url?.trim();
  if (!authority) {
    onBlocked("Blocked empty screenshot proxy tunnel target");
    sendTunnelFailure(clientSocket);
    return;
  }

  let target: ResolvedPublicHttpUrl;
  try {
    target = await resolvePublicHttpUrl(`https://${authority}/`);
  } catch (error) {
    onBlocked(getErrorMessage(error));
    sendTunnelFailure(clientSocket);
    return;
  }

  let upstreamSocket: net.Socket;
  try {
    upstreamSocket = await connectPinnedTcp(target.addresses, 443);
  } catch {
    sendTunnelFailure(clientSocket);
    return;
  }
  trackUpstream(upstreamSocket);

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstreamSocket.write(head);

  clientSocket.once("error", () => upstreamSocket.destroy());
  upstreamSocket.once("error", () => clientSocket.destroy());
  clientSocket.once("close", () => upstreamSocket.destroy());
  upstreamSocket.once("close", () => clientSocket.destroy());
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);
}

export async function startScreenshotTransportProxy(
  onBlocked: (message: string) => void,
): Promise<ScreenshotTransportProxy> {
  const clientSockets = new Set<net.Socket>();
  const upstreamSockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    void forwardHttpRequest(request, response, onBlocked).catch(() => {
      sendProxyFailure(response);
    });
  });

  server.on("connection", (socket) => {
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    void forwardConnect(
      request,
      socket as net.Socket,
      head,
      onBlocked,
      (upstreamSocket) => {
        upstreamSockets.add(upstreamSocket);
        upstreamSocket.once("close", () => upstreamSockets.delete(upstreamSocket));
      },
    ).catch(() => sendTunnelFailure(socket as net.Socket));
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Screenshot transport proxy did not expose a loopback TCP address");
  }

  let closed = false;
  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const closePromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      for (const socket of clientSockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      await closePromise;
    },
  };
}
