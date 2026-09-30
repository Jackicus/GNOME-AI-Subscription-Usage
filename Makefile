# Thin front door; all logic lives in scripts/dev.sh.
DEV := ./scripts/dev.sh

.PHONY: all link install reload logs pack providers uninstall status clean help lint

all: install

link install reload logs pack providers uninstall status clean:
	@$(DEV) $@

# gjs.guide's ESLint rules over the GJS code (eslint.config.mjs).
lint: node_modules
	@npx --no-install eslint .

node_modules: package.json
	npm install --no-audit --no-fund
	@touch $@

help:
	@$(DEV) help
