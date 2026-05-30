import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export type ArtifactMediaKind = "text" | "image" | "pdf" | "archive" | "video" | "binary";
export type ArtifactEncoding = "utf-8" | "binary";

export interface ArtifactPreviewMetadata {
  [key: string]: string | number | undefined;
  kind: "text" | "image" | "pdf" | "binary";
  line_count?: number;
  width?: number;
  height?: number;
  page_count?: number;
}

export interface ArtifactFileMetadata {
  content_type: string;
  detected_content_type: string;
  declared_content_type?: string;
  media_kind: ArtifactMediaKind;
  encoding: ArtifactEncoding;
  size_bytes: number;
  sha256: string;
  preview: ArtifactPreviewMetadata;
}

export interface ArtifactInspectionResult extends ArtifactFileMetadata {
  buffer: Buffer;
  text?: string;
}

export interface ArtifactContentTypeMismatch {
  expected: string;
  detected: string;
}

const textContentTypes = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "image/svg+xml"
]);

export function normalizeContentType(value: string): string {
  return value.trim().toLowerCase();
}

function extensionContentType(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".html":
    case ".htm":
      return "text/html";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    case ".gz":
      return "application/gzip";
    case ".tar":
      return "application/x-tar";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    default:
      return undefined;
  }
}

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  return signature.every((byte, index) => buffer[index] === byte);
}

function hasUtf8TextShape(buffer: Buffer): boolean {
  const value = buffer.toString("utf8");
  if (value.includes("\uFFFD")) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let controlCount = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) {
      continue;
    }
    if (byte < 32) {
      controlCount += 1;
    }
  }
  return controlCount === 0;
}

function detectMagicContentType(buffer: Buffer): string | undefined {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) || startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])) {
    return "application/zip";
  }
  if (startsWith(buffer, [0x1f, 0x8b])) {
    return "application/gzip";
  }
  return undefined;
}

export function detectArtifactContentType(filePath: string, buffer: Buffer): string {
  const magic = detectMagicContentType(buffer);
  if (magic) {
    return magic;
  }

  const extension = extensionContentType(filePath);
  if (extension) {
    return extension;
  }

  if (hasUtf8TextShape(buffer)) {
    const trimmed = buffer.toString("utf8").trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return "application/json";
    }
    if (/^<svg[\s>]/iu.test(trimmed)) {
      return "image/svg+xml";
    }
    return "text/plain";
  }

  return "application/octet-stream";
}

export function mediaKindForContentType(contentType: string): ArtifactMediaKind {
  if (contentType.startsWith("text/") || textContentTypes.has(contentType)) {
    return contentType === "image/svg+xml" ? "image" : "text";
  }
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType === "application/pdf") {
    return "pdf";
  }
  if (contentType === "application/zip" || contentType === "application/gzip" || contentType === "application/x-tar") {
    return "archive";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  return "binary";
}

export function encodingForContentType(contentType: string): ArtifactEncoding {
  return contentType.startsWith("text/") || textContentTypes.has(contentType) ? "utf-8" : "binary";
}

function pngPreview(buffer: Buffer): ArtifactPreviewMetadata | undefined {
  if (buffer.length < 24 || detectMagicContentType(buffer) !== "image/png") {
    return undefined;
  }
  return {
    kind: "image",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function gifPreview(buffer: Buffer): ArtifactPreviewMetadata | undefined {
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (buffer.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    return undefined;
  }
  return {
    kind: "image",
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8)
  };
}

function webpPreview(buffer: Buffer): ArtifactPreviewMetadata | undefined {
  if (buffer.length < 30 || detectMagicContentType(buffer) !== "image/webp") {
    return undefined;
  }
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk !== "VP8X") {
    return { kind: "image" };
  }
  return {
    kind: "image",
    width: 1 + buffer.readUIntLE(24, 3),
    height: 1 + buffer.readUIntLE(27, 3)
  };
}

function jpegPreview(buffer: Buffer): ArtifactPreviewMetadata | undefined {
  if (detectMagicContentType(buffer) !== "image/jpeg") {
    return undefined;
  }
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) {
      return { kind: "image" };
    }
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf
    ) {
      return {
        kind: "image",
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return { kind: "image" };
}

function pdfPreview(buffer: Buffer): ArtifactPreviewMetadata {
  const text = buffer.toString("latin1");
  const pageMatches = text.match(/\/Type\s*\/Page\b/g);
  return {
    kind: "pdf",
    ...(pageMatches ? { page_count: pageMatches.length } : {})
  };
}

function textPreview(text: string): ArtifactPreviewMetadata {
  return {
    kind: "text",
    line_count: text.length === 0 ? 0 : text.split(/\r?\n/u).length
  };
}

function previewFor(contentType: string, buffer: Buffer, text: string | undefined): ArtifactPreviewMetadata {
  if (contentType === "image/png") {
    return pngPreview(buffer) ?? { kind: "image" };
  }
  if (contentType === "image/jpeg") {
    return jpegPreview(buffer) ?? { kind: "image" };
  }
  if (contentType === "image/gif") {
    return gifPreview(buffer) ?? { kind: "image" };
  }
  if (contentType === "image/webp") {
    return webpPreview(buffer) ?? { kind: "image" };
  }
  if (contentType === "application/pdf") {
    return pdfPreview(buffer);
  }
  if (text !== undefined) {
    return textPreview(text);
  }
  return { kind: "binary" };
}

export async function inspectArtifactFile(
  filePath: string,
  declaredContentType?: string
): Promise<ArtifactInspectionResult> {
  const [stats, buffer] = await Promise.all([
    stat(filePath),
    readFile(filePath)
  ]);
  const detectedContentType = detectArtifactContentType(filePath, buffer);
  const normalizedDeclared = declaredContentType ? normalizeContentType(declaredContentType) : undefined;
  const contentType = normalizedDeclared ?? detectedContentType;
  const encoding = encodingForContentType(detectedContentType);
  const text = encoding === "utf-8" ? buffer.toString("utf8") : undefined;

  return {
    content_type: contentType,
    detected_content_type: detectedContentType,
    ...(normalizedDeclared ? { declared_content_type: normalizedDeclared } : {}),
    media_kind: mediaKindForContentType(detectedContentType),
    encoding,
    size_bytes: stats.size,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    preview: previewFor(detectedContentType, buffer, text),
    buffer,
    ...(text !== undefined ? { text } : {})
  };
}

export function contentTypeMismatch(
  metadata: ArtifactFileMetadata
): ArtifactContentTypeMismatch | undefined {
  if (!metadata.declared_content_type || metadata.detected_content_type === "application/octet-stream") {
    return undefined;
  }
  return metadata.declared_content_type === metadata.detected_content_type
    ? undefined
    : {
        expected: metadata.declared_content_type,
        detected: metadata.detected_content_type
      };
}

export function artifactMetadataFields(metadata: ArtifactFileMetadata): Omit<ArtifactFileMetadata, never> {
  return {
    content_type: metadata.content_type,
    detected_content_type: metadata.detected_content_type,
    ...(metadata.declared_content_type ? { declared_content_type: metadata.declared_content_type } : {}),
    media_kind: metadata.media_kind,
    encoding: metadata.encoding,
    size_bytes: metadata.size_bytes,
    sha256: metadata.sha256,
    preview: metadata.preview
  };
}
