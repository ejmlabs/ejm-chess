# Third-party notices

These notices describe the installed product and shared board dependencies and shipped
fonts and piece artwork. Preserve each package’s own notices when redistributing
source or a build. Tooling and transitive packages retain their own licenses in
the dependency tree and lockfile; this file does not relicense them.

## Standard chess pieces

The board uses `cm-chessboard/assets/pieces/standard.svg` without
product-specific artwork changes. Its embedded notice states:

> The chess pieces in this sprite are copies from Wikimedia Commons.
> Authors: Cburnett and Rfc1394. Modified by shaack for use in cm-chessboard.
> License: Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0).

- [Cburnett](https://en.wikipedia.org/wiki/User:Cburnett)
- [Rfc1394](https://en.wikipedia.org/wiki/User:Rfc1394)
- [shaack](https://shaack.com)
- [Original sprite and embedded notice](https://github.com/shaack/cm-chessboard/blob/master/assets/pieces/standard.svg)
- [Wikimedia source collection](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard)
- [CC BY-SA 3.0 license](https://creativecommons.org/licenses/by-sa/3.0/)
- [CC BY-SA 3.0 legal text](https://creativecommons.org/licenses/by-sa/3.0/legalcode)

The piece artwork uses this separate license. The MIT license for the
cm-chessboard code does not replace it. Retain attribution and share any adapted
piece artwork under the applicable share-alike terms. Do not ship the package’s
noncommercial Staunty sprite as part of this product.

The public `/credits/` route repeats these artwork credits and links.

## Software dependencies

| Package | Installed version | License | Attribution |
| --- | --- | --- | --- |
| `cm-chessboard` code, through the public ejm-ui board | 8.15.4 | MIT | Stefan Haack |
| `chess.js` | 1.4.0 | BSD-2-Clause | Jeff Hlywa |
| `glicko2` | 1.2.2 | MIT; upstream notice retains placeholder copyright fields | Henri Bourcereau, as named in package metadata |
| `@echecs/round-robin` | 4.1.0 | MIT | Adrian de la Rosa |
| `@echecs/tournament` | 3.3.0 | MIT | Adrian de la Rosa |
| `better-auth` | 1.7.12 | MIT | Bereket Engida |
| `@better-auth/core` | 1.7.12 | MIT | Bereket Engida |
| `jose` | 6.2.13 | MIT | Filip Skokan |
| `@cloudflare/containers` | 0.3.7 | MIT OR Apache-2.0; MIT option retained | Cloudflare, Inc. |
| `react` and `react-dom` | 19.3.1 | MIT | Meta Platforms, Inc. and affiliates |
| Public `@ejm/core`, `@ejm/ui`, `@ejm/site`, `@ejm/ssg`, and `@ejm/tokens` code | 0.1.0 | MIT | ejm-ui contributors |

The installed `glicko2` tarball declares MIT but omits a standalone license.
The exact npm release's `gitHead` points to upstream revision
`efe1e2d03f2a5a977b4dd9a2b07a169062f20f33`. Its
[verbatim MIT notice](third-party/licenses/glicko2-1.2.2-MIT.txt) is retained.
It contains literal `<year>` and `<copyright holders>` placeholders. The
package metadata names Henri Bourcereau as author; no copyright notice has
been invented. This attribution uncertainty remains a release review item.

Shared lab marks, names, and artwork remain subject to their owning
repository’s brand guidance. A code license is not a claim to the ejmlabs name
or endorsement. The chess knight and outlined wordmark belong to the shared token asset owner, with generator provenance retained there.

The installed Cloudflare Container helper declares MIT OR Apache-2.0 but omits
standalone license files. This distribution chooses the MIT option and retains
the complete [upstream MIT notice](third-party/licenses/cloudflare-containers-0.3.7-MIT.txt)
from its exact npm `gitHead`, `298169f4aaba82e7b712458b7c6b14fc3e40ad78`.
The [provenance record](third-party/license-provenance.json) records source
URLs, immutable revisions, Git blob and SHA-256 notice hashes, and verified
npm/lockfile SHA-512 tarball integrity for both packages. Installed package
bytes matched those exact tarballs. This is provenance, not a legal review.

## Private analysis image

The Worker does not import a chess engine or mating solver. Browser practice uses the separate lazy engine described below. A private Container image is implemented and locally built, with analysis disabled
by default. It has not been published or deployed.

| Image component | Pin | License and retained source |
| --- | --- | --- |
| Stockfish | 17.1, commit `03e27488f3d21d8ff4dbf3065603afa21dbd0ef3` | GPLv3; official source archive in `/opt/source/stockfish-17.1.tar.gz`, AUTHORS and COPYING in `/opt/stockfish` |
| Python chess package | `chess==1.11.2` | GPLv3 or later; complete source archive in `/opt/source/chess-1.11.2.tar.gz`, installed package notices retained |
| CPython base | 3.13.16 slim-bookworm, immutable amd64 digest in Dockerfile | Python Software Foundation and bundled component licenses retained by the official base |

The official Stockfish binary contains the pinned `nn-1c0000000000.nnue` and
`nn-37f18f62d772.nnue` networks. The build verifies their full SHA-256 hashes by
exporting them with Stockfish itself. It also checks the official binary and
corresponding source archives against `analysis/locks.json`. No engine or model
download occurs during a game or runtime analysis request.

Preserve the corresponding source, build scripts, licenses, and notices when
redistributing the image. Review the GPL source-availability path before a public
image release. The complete license texts accompany the retained source archives.
See [analysis build and source details](docs/analysis.md#pins-and-source-obligations).

## Experimental adjudication probe

`analysis/adjudication/wasm-probe/` references CHA-Solver 3.0.0 at commit
`3484c7e65247003fac8705a9290dc2b5d0978b94`, MIT, copyright 2021-2026
Miguel Ambrona. The probe's Cargo lockfile records transitive dependencies.
Selected blocked-position fixtures credit that revision's README and test corpus.
That experimental probe is outside the browser and Worker runtime. The separate
default-off native timeout-proof adapter below has its own qualification gate.

Retain the candidate's complete MIT notice with any distributed compiled probe
or copied code. Its upstream source and license are available at the
[pinned revision](https://github.com/miguel-ambrona/chasolver/tree/3484c7e65247003fac8705a9290dc2b5d0978b94).

## Private timeout-proof image

`proof/` builds the unchanged MIT CHA-Solver revision above and its unchanged
`analyzer` example. `pins.json` records the source archive, example, Cargo lock
and official image hashes. The image retains complete upstream source and MIT
notice, checksum-pinned dependency crate sources/notices, and Rust notices.

Independent history and witness validation uses `chess` 1.11.2, the maintained
python-chess distribution, licensed GPL-3.0-or-later. Its complete corresponding
source archive, extracted source and original license are retained in
`proof/vendor/` and the image's `/opt/source/` path. The source snapshot also
includes the product adapters, image definition and local qualification inputs.
Preserve these and any applicable combined-work source and notices before
distributing the image. Review the GPL source-availability path before a public
image release. No public image distribution or external license review is
claimed. See `proof/NOTICES` and [timeout proofs](docs/timeout-proofs.md).

## Browser Stockfish practice

The product vendors the unmodified lite single-thread build of `stockfish@19.0.1`, the GPL-3.0 Stockfish.js browser port maintained by Nathan Rugg and Chess.com. Stockfish engine authors retain their upstream copyrights. The exact source revision is `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`.

The served engine directory contains the upstream COPYING and AUTHORS, pinned corresponding source, required `nn-61e7af4bb97d.nnue` network, build instructions, and provenance hashes. The public `/credits/` page links these files. Preserve this source and notice path whenever distributing the engine. Bit-for-bit source rebuilding remains unverified. See [computer practice](docs/ai-opponents.md) for runtime and resource limits.

The earlier OpenRouter runtime has been removed. Historical AI records keep their original metadata. Current practice does not call an external inference provider.

## Fonts

Manrope and IBM Plex Mono are supplied through `@ejm/tokens` and use the SIL Open
Font License 1.1. The font authors’ complete notice and license text follow.

## Retained license texts

The following sections copy notices from the installed dependencies and shared
font sources. They must remain with redistributed copies as required by their
licenses.

### @echecs/round-robin and @echecs/tournament, MIT

Both installed archives include the same notice:

```text
MIT License

Copyright (c) 2024 Adrian de la Rosa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### cm-chessboard code, MIT

```text
MIT License

Copyright (c) 2017 Stefan Haack <shaack@gmail.com> (http://shaack.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### chess.js, BSD-2-Clause

```text
Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

### Better Auth, MIT

```text
The MIT License (MIT)
Copyright (c) 2024 - present, Bereket Engida

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### jose, MIT

```text
The MIT License (MIT)

Copyright (c) 2018 Filip Skokan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### React and React DOM, MIT

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Shared ejm-ui code, MIT

```text
MIT License

Copyright (c) 2026 ejm-ui contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Manrope, SIL OFL 1.1

```text
Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### IBM Plex Mono, SIL OFL 1.1

```text
Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"

This Font Software is licensed under the SIL Open Font License, Version 1.1.

This license is copied below, and is also available with a FAQ at: http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
