# Thin front door; all logic lives in scripts/dev.sh.
DEV := ./scripts/dev.sh

.PHONY: all link install reload logs pack providers parsers imports assets schemas nested shots uninstall status clean help lint check

all: install

link install reload logs pack providers parsers imports assets schemas nested shots uninstall status clean:
	@$(DEV) $@

# Everything that can be checked without a GNOME Shell.
check: lint schemas imports assets parsers

# gjs.guide's ESLint rules over the GJS code (eslint.config.mjs).
lint: node_modules
	@npx --no-install eslint .

node_modules: package.json
	npm install --no-audit --no-fund
	@touch $@

help:
	@$(DEV) help
	@echo '  make lint    ESLint with gjs.guide'"'"'s rules (eslint.config.mjs)'
	@echo '  make check   lint, schemas, imports, assets and parsers: everything'
	@echo '               that needs no GNOME Shell, and what CI runs'
