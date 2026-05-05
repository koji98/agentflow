import { existsSync, readFileSync } from "node:fs";

if (!existsSync("fix.txt")) {
  console.error("fix.txt missing");
  process.exit(1);
}

const content = readFileSync("fix.txt", "utf8");
if (!content.includes("fixed=true")) {
  console.error("fix.txt does not contain fixed=true");
  process.exit(1);
}

console.log("focused validation passed");
