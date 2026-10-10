/** Gallery fixtures for the search tools (grep). */
import type { GalleryFixture } from "./types";

export const searchFixtures: Record<string, GalleryFixture> = {
	grep: {
		label: "Grep",
		streamingArgs: {
			pattern: "useState",
		},
		args: {
			pattern: "useState",
			path: "packages/tui/src",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# packages/tui/src/components/",
						"## SearchBox.tsx",
						'18:  const [query, setQuery] = useState("");',
						"19:  const [results, setResults] = useState<Match[]>([]);",
						"## StatusBar.tsx",
						"27:  const [expanded, setExpanded] = useState(false);",
						"",
						"# packages/tui/src/hooks/",
						"## useDebounced.ts",
						"9:  const [value, setValue] = useState(initial);",
						"10:  const [pending, setPending] = useState(false);",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/tui/src",
				searchPath: "/Users/dev/Projects/pi/packages/tui/src",
				matchCount: 5,
				fileCount: 3,
				files: [
					"packages/tui/src/components/SearchBox.tsx",
					"packages/tui/src/components/StatusBar.tsx",
					"packages/tui/src/hooks/useDebounced.ts",
				],
				fileMatches: [
					{ path: "packages/tui/src/components/SearchBox.tsx", count: 2 },
					{ path: "packages/tui/src/components/StatusBar.tsx", count: 1 },
					{ path: "packages/tui/src/hooks/useDebounced.ts", count: 2 },
				],
				truncated: false,
				displayContent: [
					"# packages/tui/src/components/",
					"## SearchBox.tsx",
					'*18│  const [query, setQuery] = useState("");',
					"*19│  const [results, setResults] = useState<Match[]>([]);",
					"## StatusBar.tsx",
					"*27│  const [expanded, setExpanded] = useState(false);",
					"",
					"# packages/tui/src/hooks/",
					"## useDebounced.ts",
					" *9│  const [value, setValue] = useState(initial);",
					"*10│  const [pending, setPending] = useState(false);",
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Invalid regex pattern: unclosed group near index 8",
				},
			],
			isError: true,
			details: {
				error: "Invalid regex pattern: unclosed group near index 8",
			},
		},
	},
};
