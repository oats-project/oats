## Fixed

- Hardening: on a partial clone, `oats instance git`, `oats instance diff`
  and `oats retire` (including `--plan`) now need Git 2.45 or later and say
  so when Git is older or its version cannot be read. A retire refused this
  way changes nothing. Full clones work with any supported Git.
