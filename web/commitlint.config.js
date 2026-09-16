const scopes = ["general", "release"];

export const types = [
  {
    type: "feat",
    section: "Features",
  },
  {
    type: "fix",
    section: "Bug Fixes",
  },
  {
    type: "chore",
    section: "Chores",
  },
  {
    type: "docs",
    section: "Documentation",
  },
  {
    type: "style",
    section: "Styles",
  },
  {
    type: "refactor",
    section: "Refactor",
  },
  {
    type: "perf",
    section: "Performance",
  },
  {
    type: "test",
    section: "Tests",
  },
  {
    type: "build",
    section: "Build System",
  },
  {
    type: "ci",
    section: "Continuous Integration",
  },
];

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", scopes],
    "type-enum": [2, "always", types.map((t) => t.type)],
    "header-max-length": [2, "always", 200],
  },
};
