import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// 条件付きのclassNameをまとめ、同じCSSプロパティを指すTailwindのクラスは後ろを勝たせる。
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
