// lib/recipes.js — pre-baked utility agents (prompt-in-a-box pattern).
// Each recipe is a prompt + an optional tool hint. The hub can run a recipe:
// the recipe's prompt becomes the task for the master agent, which has the
// browser tools + memory. Recipes are first-class, discoverable, and runnable.

export const RECIPES = [
  {
    id: "tab-hygiene",
    name: "Tab hygiene",
    icon: "broom",
    description: "Find duplicate/stale tabs and close or group them.",
    prompt:
      "List the open tabs. Identify duplicates, stale tabs (same URL opened repeatedly), and tabs idle-looking enough to close. Report your findings and close the obvious duplicates. Be conservative — never close a tab with unsaved form state you can't detect.",
  },
  {
    id: "page-summary",
    name: "Summarise this page",
    icon: "doc",
    description: "Read the active tab and give a tight summary.",
    prompt:
      "Read the active tab's content and produce a concise summary: what the page is, the 3 key points, and one recommended next action. Keep it under 120 words.",
  },
  {
    id: "link-collector",
    name: "Collect links",
    icon: "link",
    description: "Gather the outbound links from the active page.",
    prompt:
      "Read the active tab and collect its outbound links, grouped by domain, with the link text. Return the list as markdown. Skip navigation/boilerplate links.",
  },
  {
    id: "reading-list",
    name: "Save to reading list",
    icon: "books",
    description: "Capture the active tab into memory as a reading-list entry.",
    prompt:
      "Read the active tab and save it to memory under the key 'reading-list' (append: title, url, and a one-line note). Confirm what you saved.",
  },
];

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id);
}
