import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

export const contextTokenizerName = "o200k_base";

const tokenizer = new Tiktoken(o200k_base);

export function encodeContextText(text: string): number[] {
  return tokenizer.encode(text);
}

export function decodeContextTokens(tokens: number[]): string {
  return tokenizer.decode(tokens);
}

export function countContextTokens(text: string): number {
  return encodeContextText(text).length;
}
