		/**
		 * Level and group are the v2 policy layer's own vocabulary. The domain
		 * roster is flat and its Remote payload carries no tier at all, so the
		 * panel reads them from the operator command channel (/team meta).
		 */
		const ROSTER_TIER_TONE = {
			0: { bg: "rgba(250,173,20,.20)", fg: "#ad6800", border: "rgba(250,173,20,.55)" },
			1: { bg: "rgba(22,119,255,.18)", fg: "#0958d9", border: "rgba(22,119,255,.50)" },
			2: { bg: "rgba(82,196,26,.18)", fg: "#389e0d", border: "rgba(82,196,26,.50)" }
		};
		const ROSTER_NEUTRAL_TONE = { bg: "rgba(140,140,140,.16)", fg: "inherit", border: "rgba(140,140,140,.42)" };
		const ROSTER_FROZEN_TONE = { bg: "rgba(255,77,79,.18)", fg: "#cf1322", border: "rgba(255,77,79,.50)" };
		const ROSTER_STATUS_TONE = {
			pending: { bg: "rgba(140,140,140,.16)", fg: "inherit", border: "rgba(140,140,140,.42)" },
			in_progress: { bg: "rgba(22,119,255,.18)", fg: "#0958d9", border: "rgba(22,119,255,.50)" },
			completed: { bg: "rgba(82,196,26,.18)", fg: "#389e0d", border: "rgba(82,196,26,.50)" }
		};
		/** One small rounded label. */
		function rosterTag(text, tone, title) {
			return (0, react_jsx_runtime.jsx)("span", {
				title,
				style: {
					display: "inline-block",
					padding: "0 6px",
					marginRight: "4px",
					borderRadius: "999px",
					fontSize: "10px",
					lineHeight: "16px",
					fontWeight: 600,
					whiteSpace: "nowrap",
					background: tone.bg,
					color: tone.fg,
					border: `1px solid ${tone.border}`
				},
				children: text
			});
		}
		/** A clickable full-width row inside the roster grid. */
		function rosterRow(options) {
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				onClick: options.onClick,
				title: options.title,
				style: {
					gridColumn: "1 / -1",
					display: "flex",
					alignItems: "center",
					gap: "6px",
					width: "100%",
					padding: options.padding ?? "3px 4px",
					margin: options.margin,
					font: "inherit",
					fontSize: "11px",
					fontWeight: options.weight ?? 700,
					textAlign: "left",
					color: "inherit",
					background: options.background ?? "transparent",
					border: "none",
					borderTop: options.borderTop,
					borderRadius: "4px",
					cursor: "pointer",
					opacity: options.opacity ?? 1
				},
				children: options.children
			}, options.key);
		}
		/** The level/group label of one board, as tags plus a readable title. */
		function boardLabel(board, t) {
			if (board.kind === "level") return { tone: ROSTER_TIER_TONE[board.tier] ?? ROSTER_NEUTRAL_TONE, tag: "L" + board.tier, title: "L" + board.tier + " " + t("levelBoard") };
			if (board.kind === "group") return { tone: ROSTER_NEUTRAL_TONE, tag: t("group"), title: String(board.group) + " " + t("groupBoard") };
			return { tone: ROSTER_NEUTRAL_TONE, tag: t("globalBoard"), title: t("globalBoard") };
		}
		/** Bucket roster members by level, then by group. */
		function rosterSections(members, teamMeta) {
			const known = /* @__PURE__ */ new Map();
			if (teamMeta !== null && typeof teamMeta === "object" && Array.isArray(teamMeta.members)) {
				for (const row of teamMeta.members) if (row !== null && typeof row === "object") known.set(row.name, row);
			}
			const sections = [];
			const index = /* @__PURE__ */ new Map();
			for (const member of members) {
				// The forked domain carries level/groupId/frozen on the roster row itself, so
			// the panel derives everything it shows from the Team payload alone: there is
			// no /team meta side channel left to go stale.
			const fromMeta = known.get(member.name);
			const derived = typeof member.level === "number" ? {
				tier: member.level,
				group: member.groupId,
				role: member.level === 0 ? "lead" : member.groupId === "verifier" ? "verifier" : member.level === 1 ? "lead" : "member",
				frozen: member.frozen === true,
			} : void 0;
			const extra = derived === void 0 ? fromMeta : { ...(fromMeta === void 0 ? {} : fromMeta), ...derived };
				const tier = extra === void 0 || extra.tier === null || extra.tier === void 0 ? -1 : extra.tier;
				const group = extra === void 0 || extra.group === null || extra.group === void 0 ? "" : String(extra.group);
				const key = tier + "\u0000" + group;
				let section = index.get(key);
				if (section === void 0) {
					section = { key, tier, group, rows: [] };
					index.set(key, section);
					sections.push(section);
				}
				section.rows.push({ member, extra });
			}
			sections.sort((a, b) => (a.tier < 0 ? 1 : b.tier < 0 ? -1 : a.tier - b.tier) || a.group.localeCompare(b.group));
			for (const section of sections) section.rows.sort((a, b) => String(a.member.name).localeCompare(String(b.member.name)));
			return sections;
		}
		/** One compact room row: round, host, next speaker and open escalations. */
		function roomConsoleRows(teamMeta, t) {
			const source = teamMeta !== null && typeof teamMeta === "object" && Array.isArray(teamMeta.rooms)
				? teamMeta.rooms
				: [];
			const rounds = teamMeta !== null && typeof teamMeta === "object" && teamMeta.rounds !== null
				? teamMeta.rounds
				: {};
			const escalations = teamMeta !== null && typeof teamMeta === "object" && Array.isArray(teamMeta.escalations)
				? teamMeta.escalations
				: [];
			const rows = [];
			for (const room of source) {
				if (room === null || typeof room !== "object") continue;
				const round = room.currentRoundId !== null && room.currentRoundId !== void 0 && rounds[room.currentRoundId] !== void 0
					? rounds[room.currentRoundId]
					: null;
				const pending = escalations.filter((row) => row !== null && typeof row === "object"
					&& row.roomId === room.roomId && row.status !== "resolved" && row.status !== "cancelled").length;
				if (room.status !== "open" && round === null && pending === 0) continue;
				rows.push({
					key: String(room.roomId),
					room,
					round,
					pending
				});
			}
			rows.sort((left, right) => {
				const leftMine = left.round !== null && left.round.status === "open" ? 1 : 0;
				const rightMine = right.round !== null && right.round.status === "open" ? 1 : 0;
				return rightMine - leftMine || String(left.room.roomId).localeCompare(String(right.room.roomId));
			});
			return rows;
		}
		/** One compact dispatch row with queue age and retry state. */
		function dispatchConsoleRows(teamMeta) {
			const rows = teamMeta !== null && typeof teamMeta === "object" && Array.isArray(teamMeta.dispatches)
				? teamMeta.dispatches.filter((row) => row !== null && typeof row === "object"
					&& !["completed", "cancelled"].includes(row.status))
				: [];
			return rows.slice().sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0)).slice(0, 12);
		}
		function compactAge(ms) {
			const value = Math.max(0, Number(ms || 0));
			if (value < 1000) return "0s";
			if (value < 60000) return Math.round(value / 1000) + "s";
			if (value < 3600000) return Math.round(value / 60000) + "m";
			return Math.round(value / 3600000) + "h";
		}
		/**
		 * The roster as level/group sections, then the levelled task boards.
		 * Every level and group label is clickable: a section heading filters the
		 * roster, a board row collapses or opens its tasks.
		 */
		function RosterView(options) {
			const { members, meta, sessionId, openTeammate, setError, t, css, StateDot } = options;
			const jsx = react_jsx_runtime.jsx;
			const jsxs = react_jsx_runtime.jsxs;
			const [filter, setFilter] = (0, react.useState)("");
			const [closed, setClosed] = (0, react.useState)({});
			const nodes = [];
			const sections = rosterSections(members, meta);
			if (filter !== "") {
				const shown = sections.find((section) => section.key === filter);
				nodes.push(rosterRow({
					key: "filter-bar",
					onClick: () => setFilter(""),
					title: t("clearFilter"),
					weight: 500,
					padding: "3px 8px",
					background: "rgba(22,119,255,.14)",
					children: [
						jsx("span", { children: t("filtering") + ": " + (shown === void 0 ? filter : (shown.tier < 0 ? t("tierUnknown") : t("tier") + " " + shown.tier + (shown.group.length === 0 ? "" : " · " + shown.group))) }),
						jsx("span", { style: { marginLeft: "auto", opacity: 0.75 }, children: t("clearFilter") })
					]
				}));
			}
			for (const section of sections) {
				const tone = ROSTER_TIER_TONE[section.tier] ?? ROSTER_NEUTRAL_TONE;
				const selected = filter === section.key;
				if (filter !== "" && !selected) continue;
				const label = section.tier < 0 ? t("tierUnknown") : t("tier") + " " + section.tier + (section.group.length === 0 ? "" : " · " + t("group") + " " + section.group);
				nodes.push(rosterRow({
					key: "section-" + section.key,
					onClick: () => setFilter(selected ? "" : section.key),
					title: t("filterHint"),
					margin: "10px 0 2px",
					background: selected ? tone.bg : "transparent",
					children: [
						jsx("span", { style: { width: "3px", height: "12px", borderRadius: "2px", background: tone.border } }),
						jsx("span", { children: label }),
						jsx("span", { style: { opacity: 0.6, fontWeight: 500 }, children: "(" + section.rows.length + ")" }),
						jsx("span", { style: { marginLeft: "auto", opacity: 0.5, fontWeight: 500 }, children: selected ? "\u2715" : "\u25be" })
					]
				}));
				for (const row of section.rows) {
					const member = row.member;
					const extra = row.extra;
					const frozen = extra !== void 0 && extra.frozen === true;
					const status = frozen ? "frozen" : member.status;
					const tags = [];
					if (section.tier >= 0) tags.push(rosterTag("L" + section.tier, ROSTER_TIER_TONE[section.tier] ?? ROSTER_NEUTRAL_TONE, t("tier")));
					if (section.group.length > 0) tags.push(rosterTag(section.group, ROSTER_NEUTRAL_TONE, t("group")));
					// The verifier is a tier-1 peer of the group leads but is NOT one of
					// them, and reading it as "组长" in the roster is simply wrong.
					const identity = extra !== void 0 && extra.role === "verifier"
						? t("roleVerifier")
						: extra !== void 0 && extra.role === "custom"
							? t("roleCustom")
							: section.tier === 0 ? t("roleLead") : section.tier === 1 ? t("roleGroupLead") : section.tier === 2 ? t("roleMember") : t("tierUnknown");
					tags.push(rosterTag(identity,
						extra !== void 0 && extra.role === "verifier" ? ROSTER_TIER_TONE[1] : ROSTER_NEUTRAL_TONE, void 0));
					if (frozen) tags.push(rosterTag("\u2744 " + t("frozen"), ROSTER_FROZEN_TONE, t("frozen")));
					nodes.push(jsxs("button", {
						type: "button",
						className: css.member,
						disabled: member.role === "lead" || status === "failed" || status === "provisioning",
						title: member.role === "teammate" ? t("open") : void 0,
						onClick: () => {
							openTeammate(sessionId, member).catch((reason) => {
								setError(String(reason));
							});
						},
						children: [
							jsx(StateDot, { state: frozen ? "error" : status === "running" ? "ongoing" : status === "failed" ? "error" : "done" }),
							jsxs("span", {
								className: css.memberText,
								children: [
									jsxs("span", {
										style: { display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: "2px" },
										children: [jsx("span", { style: { fontWeight: 600, marginRight: "6px" }, children: member.name })].concat(tags)
									}),
									jsxs("small", { children: [
										t(frozen ? "memberStatus.frozen" : memberStatusKey(status)),
										member.model === void 0 ? "" : " · " + t("model") + ": " + member.model
									] }),
									member.diagnostics.map((diagnostic) => jsx("small", {
										className: css.diagnostic,
										children: diagnostic
									}, diagnostic))
								]
							})
						]
					}, member.id));
				}
			}
			// Only the levelled boards: the global one already has the interactive
			// shared-task section below, and repeating it here reads as a duplicate.
			const all = meta !== null && typeof meta === "object" && Array.isArray(meta.boards) ? meta.boards : [];
			const boards = all.filter((board) => board !== null && typeof board === "object" && board.kind !== "global");
			if (boards.length > 0) {
				nodes.push(rosterRow({
					key: "boards-title",
					onClick: void 0,
					weight: 700,
					margin: "12px 0 2px",
					children: [
						jsx("span", { style: { width: "3px", height: "12px", borderRadius: "2px", background: "rgba(140,140,140,.5)" } }),
						jsx("span", { children: t("boards") }),
						jsx("span", { style: { marginLeft: "auto", opacity: 0.5, fontWeight: 500 }, children: t("hintToggle") })
					]
				}));
				for (const board of boards) {
					const id = String(board.id);
					const info = boardLabel(board, t);
					const tasks = Array.isArray(board.tasks) ? board.tasks : [];
					const open = closed[id] !== true;
					nodes.push(rosterRow({
						key: "board-" + id,
						onClick: () => setClosed({ ...closed, [id]: open }),
						title: open ? t("hintCollapse") : t("hintExpand"),
						borderTop: "1px solid rgba(140,140,140,.18)",
						opacity: 0.95,
						children: [
							jsx("span", { style: { width: "10px", opacity: 0.6, fontWeight: 400 }, children: open ? "\u25be" : "\u25b8" }),
							rosterTag(info.tag, info.tone, board.id),
							jsx("span", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: info.title }),
							jsx("span", { style: { marginLeft: "auto", opacity: 0.6, fontVariantNumeric: "tabular-nums" }, children: String(tasks.length) })
						]
					}));
					if (!open) continue;
					if (tasks.length === 0) {
						nodes.push(jsx("div", {
							style: { gridColumn: "1 / -1", paddingLeft: "18px", opacity: 0.55, fontSize: "11px" },
							children: t("boardEmpty")
						}, "board-empty-" + id));
						continue;
					}
					for (const task of tasks) {
						if (task === null || typeof task !== "object") continue;
						nodes.push(jsxs("div", {
							style: {
								gridColumn: "1 / -1",
								display: "flex",
								alignItems: "center",
								gap: "6px",
								paddingLeft: "18px",
								paddingBottom: "1px",
								fontSize: "11px"
							},
							children: [
								jsx("span", { style: { opacity: 0.5 }, children: "\u2022" }),
								jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: String(task.subject) }),
								rosterTag(t(statusKey(task.status)), ROSTER_STATUS_TONE[task.status] ?? ROSTER_NEUTRAL_TONE, String(task.status)),
								task.ownerName === void 0 ? null : jsx("span", { style: { opacity: 0.6, marginLeft: "auto" }, children: String(task.ownerName) })
							]
						}, "task-" + id + "-" + String(task.id)));
					}
				}
			}
			const rooms = roomConsoleRows(meta, t);
			if (rooms.length > 0) {
				nodes.push(rosterRow({
					key: "rooms-title",
					weight: 700,
					margin: "12px 0 2px",
					children: [
						jsx("span", { style: { width: "3px", height: "12px", borderRadius: "2px", background: "rgba(22,119,255,.55)" } }),
						jsx("span", { children: t("rooms") }),
						jsx("span", { style: { marginLeft: "auto", opacity: 0.6, fontWeight: 500 }, children: String(rooms.length) })
					]
				}));
				for (const row of rooms) {
					const round = row.round;
					const marker = round === null ? t("roomIdle") : t("nextSpeaker") + ": " + String(round.nextSpeaker ?? "—");
					nodes.push(jsxs("div", {
						style: {
							gridColumn: "1 / -1",
							display: "grid",
							gridTemplateColumns: "minmax(0,1fr) auto",
							gap: "2px 8px",
							padding: "5px 7px",
							borderTop: "1px solid rgba(140,140,140,.14)",
							fontSize: "11px"
						},
						children: [
							jsxs("div", {
								style: { minWidth: 0 },
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: "5px", minWidth: 0 },
										children: [
											rosterTag(String(row.room.kind || "room"), ROSTER_TIER_TONE[0], String(row.room.roomId)),
											jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }, children: String(row.room.roomId) }),
											rosterTag(String(row.room.status), ROSTER_STATUS_TONE[row.room.status] ?? ROSTER_NEUTRAL_TONE, String(row.room.status))
										]
									}),
									jsx("div", { style: { opacity: 0.68, marginTop: "2px" }, children: [
										t("host") + ": " + String(row.room.host ?? "—"),
										round === null ? "" : " · " + t("round") + ": " + String(round.topic || round.roundId),
										" · " + marker,
										row.pending > 0 ? " · " + t("pendingEscalations") + ": " + String(row.pending) : ""
									].join("") })
								]
							}),
							jsx("span", { style: { opacity: 0.6, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
								children: round === null ? "" : String((round.mainSpoken ?? round.spoken ?? []).length) + "/" + String((round.order ?? []).length) })
						]
					}, "room-" + row.key));
				}
			}
			const dispatches = dispatchConsoleRows(meta);
			if (dispatches.length > 0) {
				const now = Date.now();
				nodes.push(rosterRow({
					key: "dispatches-title",
					weight: 700,
					margin: "12px 0 2px",
					children: [
						jsx("span", { style: { width: "3px", height: "12px", borderRadius: "2px", background: "rgba(250,173,20,.65)" } }),
						jsx("span", { children: t("dispatches") }),
						jsx("span", { style: { marginLeft: "auto", opacity: 0.6, fontWeight: 500 }, children: String(dispatches.length) })
					]
				}));
				for (const dispatch of dispatches) {
					const queueAge = ["queued", "delivered"].includes(dispatch.status)
						? compactAge(Number(dispatch.queueAgeMs ?? (now - Number(dispatch.createdAt || now))))
						: "—";
					nodes.push(jsxs("div", {
						style: {
							gridColumn: "1 / -1",
							display: "flex",
							alignItems: "center",
							gap: "6px",
							padding: "4px 7px",
							borderTop: "1px solid rgba(140,140,140,.14)",
							fontSize: "11px",
							minWidth: 0
						},
						children: [
							rosterTag(String(dispatch.status), ["timed-out", "expired", "delivery-failed", "run-failed"].includes(dispatch.status) ? ROSTER_FROZEN_TONE : ROSTER_NEUTRAL_TONE, String(dispatch.status)),
							jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: String(dispatch.sender || "?") + " → " + String(dispatch.target || "?") }),
							jsx("span", { style: { opacity: 0.65, marginLeft: "auto", whiteSpace: "nowrap" }, children: t("queueAge") + ": " + queueAge + (Number(dispatch.attempt || 0) > 1 ? " · " + t("attempt") + " " + String(dispatch.attempt) : "") }),
							dispatch.lastError === null || dispatch.lastError === void 0 ? null : jsx("span", { title: String(dispatch.lastError), style: { opacity: 0.55 }, children: "!" })
						]
					}, "dispatch-" + String(dispatch.dispatchId)));
				}
			}
			return nodes;
		}
