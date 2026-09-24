// Filesystem — the storage seam under the artifact family (write_file /
// read_file / preview all take `{ fs }`).
//
// The library owns the CONTRACT (this interface) plus adapters for the
// web-standard platforms: OPFS (origin-private real directory tree, zero
// consent — the default scratch workspace) and FSA (a granted
// FileSystemDirectoryHandle over the user's real folder). The two share one
// API, so "built-in workspace ⇄ connected folder" is just swapping the root
// handle. Platform exotics (mini-program wx.getFileSystemManager, Node fs)
// are host territory — the library can never cover them.
//
// Precedents: createBrowserFrame (generic browser code lives in the library);
// ask_user handlers (host decisions live in the host). Adapters are the
// former — zero host decisions inside.
//
// Structural handle types (DirHandle/FileHandle) instead of lib.dom's FSA
// typings — same trick as PreviewDriverGlobal: tests supply fakes of exactly
// this shape, and we don't depend on TS's coverage of async iteration.
//
// Path rules: '/'-separated relative paths, '..' refused (escape), '.' and
// empty segments collapsed, leading '/' stripped. No symlink concept exists
// in FSA/OPFS — confinement is lexical-only and free.
//
// Multi-tenant roots (2026-09-19): hosts driving many tenants under one
// granted folder (tooolx's projects) use scope() — a subdirectory-rooted
// Filesystem, confined BY HANDLE rather than by host-side path prefixing.
// That keeps the escape-proofing in this module instead of every host.

/** Structural directory handle — a real FSA/OPFS handle, or a test fake. */
export interface DirHandle {
	kind: "directory";
	name: string;
	getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
	getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
	values(): AsyncIterableIterator<{ kind: string; name: string }>;
	/** FSA + OPFS both ship it; optional so minimal fakes can skip delete. */
	removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
	/** FSA only (OPFS handles don't have them) — used by hosts to re-auth. */
	queryPermission?(desc: { mode: "read" | "readwrite" }): Promise<string>;
	requestPermission?(desc: { mode: "read" | "readwrite" }): Promise<string>;
}

/** Structural file handle. */
export interface FileHandle {
	kind: "file";
	name: string;
	getFile(): Promise<{ text(): Promise<string>; size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
	createWritable(): Promise<FileWritable>;
}

export interface FileWritable {
	/** FSA's real stream accepts strings AND byte buffers; move() copies
	 *  binaries byte-exact, so the structural type must admit both. */
	write(data: string | BufferSource): Promise<void>;
	close(): Promise<void>;
	abort?(): Promise<void>;
}

/** The storage seam: what write_file / read_file / preview operate on. */
export interface Filesystem {
	/** Throw on miss with a message that usefully says "not found". */
	readFile(path: string, signal?: AbortSignal): Promise<string>;
	/** Raw bytes of a file (images/media/any binary) — hosts building data URLs
	 *  or byte-accurate views need this; text() mangles binaries. Optional —
	 *  same backends that ship readFile can add it cheaply. */
	readFileBytes?(path: string, signal?: AbortSignal): Promise<Uint8Array>;
	/** Creates parent directories as needed (workspace semantics). */
	writeFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
	/** "" or "." lists the root. Names of directories carry a trailing "/". */
	listDir?(path: string, signal?: AbortSignal): Promise<string[]>;
	/** Delete a file, or a directory when it is empty — non-empty directories
	 *  refuse unless opts.recursive is true (the caller's explicit choice).
	 *  A missing entry rejects with the same "not found" wording as readFile.
	 *  Optional — flat hosts may not support deletion. */
	remove?(
		path: string,
		signal?: AbortSignal,
		opts?: { recursive?: boolean },
	): Promise<void>;
	/** Move/rename: copy `from` (file or whole directory) to `to` — parent
	 *  directories created, existing destination overwritten — then delete
	 *  the source. Moving a path into itself refuses. Optional, hierarchical
	 *  backends only. */
	move?(from: string, to: string, signal?: AbortSignal): Promise<void>;
	/** A full workspace rooted at a subdirectory (created on demand) — the
	 *  structural way to host many tenants (projects) under one root: the
	 *  returned fs is confined by ROOT HANDLE, not by path prefixing, so
	 *  escapes are impossible regardless of the caller's path handling.
	 *  Optional — requires listDir-capable, hierarchical backends. */
	scope?(path: string, signal?: AbortSignal): Promise<Filesystem>;
}

/** Normalize a model-supplied path; null means refuse (escape or empty). */
export function normalizeFsPath(input: string): string | null {
	const segs: string[] = [];
	for (const seg of input.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") return null;
		segs.push(seg);
	}
	return segs.length === 0 ? null : segs.join("/");
}

const checkSignal = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new Error("aborted");
};

async function dirFor(root: DirHandle, segs: string[], mkdir: boolean): Promise<DirHandle> {
	let dir = root;
	for (const s of segs) {
		dir = await dir.getDirectoryHandle(s, mkdir ? { create: true } : undefined);
	}
	return dir;
}

const notFound = (path: string): Error => new Error(`'${path}' not found in the workspace`);

const isMiss = (err: unknown): boolean => {
	const msg = err instanceof Error ? err.message : String(err);
	return /not ?found|could not be resolved|a requested file/i.test(msg);
};

/** 目录项的类型探测:列父目录按名字找(异常嗅探不可靠——各后端对「名字
 *  是目录/文件」抛的错误形态不一,枚举是唯一稳的)。null = 不存在。 */
async function entryKind(dir: DirHandle, name: string): Promise<"file" | "dir" | null> {
	for await (const e of dir.values()) {
		if (e.name === name) return e.kind === "directory" ? "dir" : "file";
	}
	return null;
}

/** move() 的搬运半边:srcRel(文件或整棵目录)按字节复制到 dstRel(父目录
 *  按需创建,目标已存在则覆盖)。FSA 没有原生 rename,copy+delete 是唯一
 *  通用实现;二进制走 arrayBuffer,文本同样按字节转(无损)。 */
async function copyEntry(
	root: DirHandle,
	srcRel: string,
	dstRel: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	checkSignal(signal);
	const sSegs = srcRel.split("/");
	const sName = sSegs.pop()!;
	const dSegs = dstRel.split("/");
	const dName = dSegs.pop()!;
	const sDir = await dirFor(root, sSegs, false);
	const dDir = await dirFor(root, dSegs, true);
	const kind = await entryKind(sDir, sName);
	if (kind === null) throw notFound(srcRel);
	if (kind === "file") {
		const fh = await sDir.getFileHandle(sName);
		const bytes = await (await fh.getFile()).arrayBuffer();
		const dst = await dDir.getFileHandle(dName, { create: true });
		const w = await dst.createWritable();
		try {
			await w.write(bytes);
			await w.close();
		} catch (err) {
			void w.abort?.();
			throw err;
		}
		return;
	}
	// 目录:建目标目录后逐项递归(空目录同样成立)
	const sSub = await sDir.getDirectoryHandle(sName);
	const dSub = await dDir.getDirectoryHandle(dName, { create: true });
	for await (const e of sSub.values()) {
		await copyEntry(root, `${srcRel}/${e.name}`, `${dstRel}/${e.name}`, signal);
	}
}

/** Build the Filesystem over any directory handle (OPFS or FSA share it). */
function fsFromRoot(root: DirHandle): Filesystem {
	return {
		async readFile(path, signal) {
			const norm = normalizeFsPath(path);
			if (norm === null) throw new Error(`invalid workspace path '${path}'`);
			checkSignal(signal);
			const segs = norm.split("/");
			const name = segs.pop()!;
			try {
				const dir = await dirFor(root, segs, false);
				const fh = await dir.getFileHandle(name);
				checkSignal(signal);
				return await (await fh.getFile()).text();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/not ?found|could not be resolved|a requested file/i.test(msg)) throw notFound(path);
				throw err;
			}
		},
		async readFileBytes(path, signal) {
			const norm = normalizeFsPath(path);
			if (norm === null) throw new Error(`invalid workspace path '${path}'`);
			checkSignal(signal);
			const segs = norm.split("/");
			const name = segs.pop()!;
			try {
				const dir = await dirFor(root, segs, false);
				const fh = await dir.getFileHandle(name);
				checkSignal(signal);
				return new Uint8Array(await (await fh.getFile()).arrayBuffer());
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/not ?found|could not be resolved|a requested file/i.test(msg)) throw notFound(path);
				throw err;
			}
		},
		async writeFile(path, content, signal) {
			const norm = normalizeFsPath(path);
			if (norm === null) throw new Error(`invalid workspace path '${path}'`);
			checkSignal(signal);
			const segs = norm.split("/");
			const name = segs.pop()!;
			const dir = await dirFor(root, segs, true); // mkdir parents
			const fh = await dir.getFileHandle(name, { create: true });
			const w = await fh.createWritable();
			try {
				await w.write(content);
				await w.close();
			} catch (err) {
				void w.abort?.();
				throw err;
			}
		},
		async listDir(path, signal) {
			checkSignal(signal);
			const trimmed = path.trim();
			const dir =
				trimmed === "" || trimmed === "."
					? root
					: await dirFor(root, (normalizeFsPath(trimmed) ?? "").split("/").filter(Boolean), false);
			const out: string[] = [];
			for await (const e of dir.values()) {
				out.push(e.kind === "directory" ? `${e.name}/` : e.name);
			}
			out.sort();
			return out;
		},
		async remove(path, signal, opts) {
			const norm = normalizeFsPath(path);
			if (norm === null) throw new Error(`invalid workspace path '${path}'`);
			checkSignal(signal);
			const segs = norm.split("/");
			const name = segs.pop()!;
			try {
				const dir = await dirFor(root, segs, false);
				if (dir.removeEntry === undefined)
					throw new Error("remove unavailable in this backend");
				checkSignal(signal);
				// 文件直接删;目录只有在为空、或调用方显式给了 recursive 时才删
				const kind = await entryKind(dir, name);
				if (kind === null) throw notFound(path);
				if (kind === "dir") {
					const sub = await dir.getDirectoryHandle(name);
					if (opts?.recursive !== true) {
						for await (const _entry of sub.values()) {
							throw new Error(`'${path}' is a non-empty directory — recursive deletion requires an explicit opt-in`);
						}
					}
					await dir.removeEntry(name, { recursive: true });
				} else {
					await dir.removeEntry(name);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/not ?found|could not be resolved/i.test(msg)) throw notFound(path);
				throw err;
			}
		},
		async move(from, to, signal) {
			const fnorm = normalizeFsPath(from);
			const tnorm = normalizeFsPath(to);
			if (fnorm === null) throw new Error(`invalid workspace path '${from}'`);
			if (tnorm === null) throw new Error(`invalid workspace path '${to}'`);
			if (tnorm === fnorm || tnorm.startsWith(`${fnorm}/`))
				throw new Error(`cannot move '${from}' into itself`);
			checkSignal(signal);
			try {
				await copyEntry(root, fnorm, tnorm, signal);
			} catch (err) {
				if (isMiss(err)) throw notFound(from);
				throw err;
			}
			const segs = fnorm.split("/");
			const name = segs.pop()!;
			const dir = await dirFor(root, segs, false);
			if (dir.removeEntry === undefined)
				throw new Error("remove unavailable in this backend");
			checkSignal(signal);
			await dir.removeEntry(name, { recursive: true });
		},
		async scope(path, signal) {
			const norm = normalizeFsPath(path);
			if (norm === null) throw new Error(`invalid workspace path '${path}'`);
			checkSignal(signal);
			// 子目录按需创建(workspace 语义:首次写入即落盘;scope 早一步无妨)
			const dir = await dirFor(root, norm.split("/"), true);
			return fsFromRoot(dir);
		},
	};
}

/** OPFS workspace — the zero-consent default (origin-private real fs). */
export async function createOpfsFilesystem(): Promise<Filesystem> {
	const nav = navigator as unknown as {
		storage?: { getDirectory?(): Promise<DirHandle> };
	};
	const root = await nav.storage?.getDirectory?.();
	if (root === undefined) {
		throw new Error("OPFS unavailable (navigator.storage.getDirectory missing in this runtime)");
	}
	return fsFromRoot(root);
}

/** FSA workspace over a granted directory handle (readwrite consent given by
 *  the picker; re-auth after restart is the host's gesture-wired business). */
export function createFsaFilesystem(root: DirHandle): Filesystem {
	return fsFromRoot(root);
}
