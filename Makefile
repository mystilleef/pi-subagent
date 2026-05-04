.DEFAULT_GOAL := verify

.PHONY: help verify coverage check migrate install update

help:
	@printf '%s\n' \
		'Available targets:' \
		'  verify    Run checks and tests' \
		'  coverage  Run checks and tests with coverage' \
		'  check     Fix lint issues and type-check' \
		'  migrate   Run Biome migrations'

migrate:
	bun migrate

check:
	bun check

verify:
	bun verify

coverage:
	bun coverage

install:
	bun install

update:
	bun update --latest
