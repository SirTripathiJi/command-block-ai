.PHONY: setup run test clean
setup:
	npm install --no-audit --no-fund
run:
	npm start
test:
	npm test
clean:
	rm -rf node_modules coverage logs
