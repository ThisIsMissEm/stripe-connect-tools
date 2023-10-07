import { render } from "prettyjson";

export function debug(type, object) {
  console.log(`\n\n${type}:\n${render(object)}\n\n`);
}
