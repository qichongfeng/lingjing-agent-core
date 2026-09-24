// Filesystem adapter tests — the FSA/OPFS traversal logic exercised against
// fake handles of exactly the DirHandle/FileHandle shape (createFsaFilesystem
// and OPFS share fsFromRoot, so one fake root covers both).

import { describe, expect, test } from "vitest";
import { createFsaFilesystem, normalizeFsPath } from "../src/index.js";
import type { DirHandle, FileHandle } from "../src/index.js";

class FakeFileHandle implements FileHandle {
	kind = "file" as const;
	content: string;
	constructor(
		public name: string,
		content: string,
	) {
		this.content = content;
	}
	async getFile() {
		// latin-1 逐码位编字节:测试可写 "\u0089PNG…" 直取 0x89 字节
		const bytes = Uint8Array.from(this.content, (c) => c.charCodeAt(0));
		return {
			text: async () => this.content,
			size: this.content.length,
			arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
		};
	}
	async createWritable() {
		const file = this;
		return {
			// move() 按字节写 ArrayBuffer:latin-1 逐字节还原成字符串(与
			// getFile 的编码互逆),文本/二进制往返无损
			async write(data: string | BufferSource) {
				if (typeof data === "string") {
					file.content = data;
					return;
				}
				const src =
					data instanceof ArrayBuffer
						? new Uint8Array(data)
						: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
				let s = "";
				for (const b of src) s += String.fromCharCode(b);
				file.content = s;
			},
			async close() {},
		};
	}
}

class FakeDirHandle implements DirHandle {
	kind = "directory" as const;
	children = new Map<string, DirHandle | FakeFileHandle>();
	constructor(
		public name: string,
		public onGet?: (name: string) => void,
	) {}
	addDir(name: string): FakeDirHandle {
		const d = new FakeDirHandle(name);
		this.children.set(name, d);
		return d;
	}
	addFile(name: string, content: string): FakeFileHandle {
		const f = new FakeFileHandle(name, content);
		this.children.set(name, f);
		return f;
	}
	async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle> {
		const c = this.children.get(name);
		if (c instanceof FakeDirHandle) return c;
		if (c !== undefined) throw new Error(`a file exists at '${name}'`);
		if (opts?.create === true) return this.addDir(name);
		this.onGet?.(name);
		throw new Error(`A requested file or directory could not be resolved at '${name}'`);
	}
	async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle> {
		const c = this.children.get(name);
		if (c instanceof FakeFileHandle) return c;
		if (c !== undefined) throw new Error(`a directory exists at '${name}'`);
		if (opts?.create === true) return this.addFile(name, "");
		this.onGet?.(name);
		throw new Error(`A requested file or directory could not be resolved at '${name}'`);
	}
	async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
		const c = this.children.get(name);
		if (c === undefined)
			throw new Error("A requested file or directory could not be resolved at '" + name + "'");
		if (c instanceof FakeDirHandle && c.children.size > 0 && opts?.recursive !== true)
			throw new Error(`directory '${name}' not empty`);
		this.children.delete(name);
	}
	async *values(): AsyncIterableIterator<{ kind: string; name: string }> {
		for (const [name, c] of this.children) yield { kind: c.kind, name };
	}
}

describe("normalizeFsPath", () => {
	test("collapses empty/./ segments, strips leading slash", () => {
		expect(normalizeFsPath("/a//b/./c")).toBe("a/b/c");
		expect(normalizeFsPath("./x")).toBe("x");
	});
	test("refuses .. escapes and empty results", () => {
		expect(normalizeFsPath("../x")).toBeNull();
		expect(normalizeFsPath("a/../../b")).toBeNull();
		expect(normalizeFsPath("/")).toBeNull();
		expect(normalizeFsPath(".")).toBeNull();
	});
});

describe("createFsaFilesystem (fsFromRoot)", () => {
	test("reads nested files; misses become 'not found in the workspace'", async () => {
		const root = new FakeDirHandle("root");
		root.addDir("games").addFile("snake.html", "<html>ok</html>");
		const fs = createFsaFilesystem(root);
		await expect(fs.readFile("games/snake.html")).resolves.toBe("<html>ok</html>");
		await expect(fs.readFile("games/missing.html")).rejects.toThrow("not found in the workspace");
		await expect(fs.readFile("../escape")).rejects.toThrow("invalid workspace path");
	});

	test("readFileBytes returns raw bytes (binary-safe)", async () => {
		const root = new FakeDirHandle("root");
		root.addFile("logo.png", "\u0089PNG-fake-bytes");
		const fs = createFsaFilesystem(root);
		const bytes = await fs.readFileBytes!("logo.png");
		expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, ..."-fake-bytes".split("").map((c) => c.charCodeAt(0))]);
		await expect(fs.readFileBytes!("missing.png")).rejects.toThrow("not found in the workspace");
	});

	test("writeFile creates parent directories and overwrites", async () => {
		const root = new FakeDirHandle("root");
		const fs = createFsaFilesystem(root);
		await fs.writeFile("games/arcade/snake.html", "v1");
		await fs.writeFile("games/arcade/snake.html", "v2");
		await expect(fs.readFile("games/arcade/snake.html")).resolves.toBe("v2");
		expect([...root.children.keys()]).toEqual(["games"]); // parent dirs materialized
	});

	test("writeFile refuses .. and honors an aborted signal", async () => {
		const root = new FakeDirHandle("root");
		const fs = createFsaFilesystem(root);
		await expect(fs.writeFile("../x", "y")).rejects.toThrow("invalid workspace path");
		const ac = new AbortController();
		ac.abort();
		await expect(fs.writeFile("x", "y", ac.signal)).rejects.toThrow("aborted");
	});

	test("listDir lists root and subdirs, directories with trailing slash", async () => {
		const root = new FakeDirHandle("root");
		root.addDir("games");
		root.addFile("readme.md", "hi");
		root.addDir("games").addFile("snake.html", "<html></html>");
		const fs = createFsaFilesystem(root);
		await expect(fs.listDir!("")).resolves.toEqual(["games/", "readme.md"]);
		await expect(fs.listDir!("games")).resolves.toEqual(["snake.html"]);
		await expect(fs.listDir!(".")).resolves.toEqual(["games/", "readme.md"]);
	});

	test("a directory blocking a file path surfaces a real error", async () => {
		const root = new FakeDirHandle("root");
		root.addDir("x");
		const fs = createFsaFilesystem(root);
		await expect(fs.readFile("x")).rejects.toThrow("directory exists");
	});
});

describe("remove", () => {
	test("deletes files and empty dirs without recursive; misses say not found", async () => {
		const root = new FakeDirHandle("root");
		root.addDir("empty");
		root.addFile("index.html", "hi");
		const fs = createFsaFilesystem(root);
		await fs.remove!("index.html");
		await fs.remove!("empty");
		await expect(fs.listDir!("")).resolves.toEqual([]);
		await expect(fs.remove!("gone.html")).rejects.toThrow("not found in the workspace");
		await expect(fs.remove!("..")).rejects.toThrow("invalid workspace path");
	});
	test("a non-empty directory refuses without recursive, deletes with it", async () => {
		const root = new FakeDirHandle("root");
		root.addDir("site").addDir("assets").addFile("logo.svg", "<svg/>");
		const fs = createFsaFilesystem(root);
		await expect(fs.remove!("site")).rejects.toThrow("non-empty directory");
		await expect(fs.remove!("site", undefined, { recursive: true })).resolves.toBeUndefined();
		await expect(fs.listDir!("")).resolves.toEqual([]);
	});
});

describe("move", () => {
	test("renames a file, relocates it (parents created), overwrites the destination", async () => {
		const root = new FakeDirHandle("root");
		root.addFile("snake-v2.html", "v2");
		root.addFile("old.html", "stale");
		const fs = createFsaFilesystem(root);
		await fs.move!("snake-v2.html", "snake.html");
		await expect(fs.readFile("snake.html")).resolves.toBe("v2");
		await expect(fs.readFile("snake-v2.html")).rejects.toThrow("not found");
		await fs.move!("snake.html", "archive/final/snake.html");
		await expect(fs.readFile("archive/final/snake.html")).resolves.toBe("v2");
		await fs.move!("old.html", "archive/final/snake.html"); // 覆盖目标
		await expect(fs.readFile("archive/final/snake.html")).resolves.toBe("stale");
	});
	test("moves a whole directory tree byte-exact (binary-safe)", async () => {
		const root = new FakeDirHandle("root");
		const site = root.addDir("site");
		site.addFile("logo.png", "PNG-fake");
		site.addDir("assets").addFile("a.svg", "<svg/>");
		const fs = createFsaFilesystem(root);
		await fs.move!("site", "backup/site");
		await expect(fs.readFile("backup/site/logo.png")).resolves.toBe("PNG-fake");
		const bytes = await fs.readFileBytes!("backup/site/logo.png");
		expect(bytes[0]).toBe(0x89);
		await expect(fs.readFile("backup/site/assets/a.svg")).resolves.toBe("<svg/>");
		await expect(fs.listDir!("")).resolves.toEqual(["backup/"]); // 源已删
	});
	test("refuses moving into itself and reports missing sources", async () => {
		const root = new FakeDirHandle("root");
		root.addDir("site").addFile("a.html", "a");
		const fs = createFsaFilesystem(root);
		await expect(fs.move!("site", "site/sub")).rejects.toThrow("into itself");
		await expect(fs.move!("site", "site")).rejects.toThrow("into itself");
		await expect(fs.move!("gone.html", "x.html")).rejects.toThrow("not found in the workspace");
	});
});

describe("scope", () => {
	test("subdirectory-rooted fs is confined by handle, folder created on demand", async () => {
		const root = new FakeDirHandle("root");
		root.addFile("root-secret.txt", "s");
		const base = createFsaFilesystem(root);
		// scope 即建目录(项目文件夹选择即落盘)
		const proj = await base.scope!("my-project");
		await proj.writeFile("index.html", "<html></html>");
		await proj.writeFile("deep/nested/a.txt", "a");
		await expect(proj.listDir!("")).resolves.toEqual(["deep/", "index.html"]);
		// 根 handle 级收界:scope 里看不见、也够不到兄弟与父级内容
		await expect(proj.readFile("root-secret.txt")).rejects.toThrow("not found");
		await expect(proj.readFile("../root-secret.txt")).rejects.toThrow("invalid workspace path");
		await expect(base.listDir!("")).resolves.toEqual(["my-project/", "root-secret.txt"]);
		// scope 可以再嵌 scope
		const nested = await proj.scope!("sub");
		await nested.writeFile("x.txt", "x");
		await expect(nested.listDir!("")).resolves.toEqual(["x.txt"]);
		// 落盘位置直接从 fake 根校验(绕过被测层)
		await expect(listFakeDir(root, "my-project/sub")).resolves.toEqual(["x.txt"]);
	});
});

/** 断言辅助:直接从 fake 根沿路径下钻列目录(绕过被测层,校验真实落盘位置) */
async function listFakeDir(root: FakeDirHandle, folder: string): Promise<string[]> {
	let dir: DirHandle = root;
	for (const seg of folder.split("/")) dir = await dir.getDirectoryHandle(seg);
	const out: string[] = [];
	for await (const e of dir.values()) out.push(e.kind === "directory" ? `${e.name}/` : e.name);
	return out.sort();
}
