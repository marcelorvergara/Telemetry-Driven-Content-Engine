TINYGO ?= tinygo
DIST   := ../go-wasm
OUT    := $(DIST)/gpmf.wasm

.PHONY: build clean size

build:
	mkdir -p $(DIST)
	$(TINYGO) build \
		-target wasm \
		-no-debug \
		-panic=trap \
		-o $(OUT) \
		./...

# Reports binary size — stay well under the 64 MB WASM heap budget.
size: build
	ls -lh $(OUT)

clean:
	rm -f $(OUT)
