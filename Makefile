NODE_VERSION ?= 22.23.3

.PHONY: install build test typecheck check demo-trust demo-trust-v2

install:
	npm ci --prefix backend
	npm ci --prefix ui

build:
	npm run build --prefix backend
	npm run build --prefix ui

test:
	npm test --prefix backend
	npm test --prefix ui

typecheck:
	npm exec --prefix backend -- tsc --noEmit --project backend/tsconfig.json
	npm exec --prefix ui -- tsc --project ui/tsconfig.json --noEmit

check: typecheck build test

demo-trust:
	LOOP_ENGINE=legacy npm run demo:trust --prefix backend

demo-trust-v2:
	LOOP_ENGINE=v2 npm run demo:trust --prefix backend
