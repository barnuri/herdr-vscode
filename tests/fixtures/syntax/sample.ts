/* Block comment
   over two lines */
import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";

export interface User<T = string> {
  id: number;
  name: T;
}

@Injectable()
export class Greeter extends Base implements Service {
  private readonly cache = new Map<string, User>();
  static MAX_USERS = 0x1f;

  async greet(user: User, retries = 3): Promise<string> {
    if (!user?.name || retries <= 0) {
      throw new Error(`no user: ${user.id}\n`);
    }
    const re = /^[a-z]+\d*$/gi;
    for (const [key, value] of this.cache.entries()) {
      console.log(key, value.name, re.test(key));
    }
    return await readFile("hello.txt", "utf8") + ", " + user.name;
  }
}

export const enabled = true, missing = null;
const view = <Panel title="x" onClick={() => setOpen(!open)} />;
