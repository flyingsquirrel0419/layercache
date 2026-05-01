"use server";
import { search } from "@/lib/search-index";

export async function searchDocs(query: string) {
  return search(query);
}
