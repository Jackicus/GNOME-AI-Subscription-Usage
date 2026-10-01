include scripts/kit.mk

# AI Usage's own: the offline checks one at a time (make check runs them all),
# the providers as the extension would see them (real logins and the network:
# the user's to run), and the published screenshots, over stand-in data.
.PHONY: imports assets parsers providers shots

imports assets parsers providers:
	@$(DEV) $@

shots:
	@$(NESTED) shots
