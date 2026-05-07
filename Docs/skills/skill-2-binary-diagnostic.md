# Skill 2 — Binary Diagnostic Probe

**When to use**: A KLV walk produces garbage FourCCs, a wrong sample count, or an unexpected `ErrMalformedGPMF` that does not map to a known bad offset.

**What it does**: Prints the full parse state at every field boundary, making stride misalignment and size/repeat overflow immediately visible without a debugger.

---

## Probe Code

Insert inside the GPMF walk loop (remove before committing):

```go
fourcc  := buf[pos : pos+4]
typ     := buf[pos+4]
size    := buf[pos+5]
rep     := binary.BigEndian.Uint16(buf[pos+6:])
dataLen := int(size) * int(rep)
padded  := (dataLen + 3) &^ 3
fmt.Printf("[KLV] pos=%d  key=%q  type=0x%02X  size=%d  rep=%d  dataLen=%d  nextPos=%d\n",
    pos, fourcc, typ, size, rep, dataLen, pos+8+padded)
```

---

## Reading the Output

| Observation | Diagnosis |
|---|---|
| `key` is not printable ASCII | Cursor misaligned — Stride Alignment Rule violated upstream |
| `nextPos` ≥ buffer length | `size × repeat` overflow — malformed or truncated file |
| Every other FourCC is wrong but alternating ones are correct | Data length is odd and `&^ 3` pad was omitted |
| `size=0, rep=0` on a non-container field | SCAL was consumed as a data row; STRM state machine has a bug |

---

## Stride Formula (the rule the probe validates)

```go
pos += 8 + (int(size)*int(repeat)+3)&^3
```
