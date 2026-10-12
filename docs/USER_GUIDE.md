# ModDotPlot Browser User Guide & Tutorial

> **Note:** This project was generated using ChatGPT 5.6 Sol (ie. vibe-coded) under the direction of Adam Phillippy and Alex Sweeten. For analyses intended for publication, please use the official [ModDotPlot CLI](https://github.com/marbl/ModDotPlot) and cite the [ModDotPlot paper](https://doi.org/10.1093/bioinformatics/btae493).

## Table of contents

- [ModDotPlot Browser User Guide \& Tutorial](#moddotplot-browser-user-guide--tutorial)
  - [Table of contents](#table-of-contents)
  - [Getting started](#getting-started)
  - [Plot Navigation](#plot-navigation)
    - [Self Plot](#self-plot)
    - [Pairwise Plot](#pairwise-plot)
    - [Grid plot](#grid-plot)
  - [Plot Resolution](#plot-resolution)
  - [Plot Customization](#plot-customization)
  - [Exporting a config for ModDotPlot CLI](#exporting-a-config-for-moddotplot-cli)

## Getting started

`ModDotPlot Browser` has been tested and works on current versions of Google Chrome, Microsoft Edge, Mozilla Firefox, and Safari. Web browsers must have WebAssembly, Web Workers, and WebGL2 enabled. Mobile browsers appear to be compatible, although navigating plots with touchscreen controls may be more challenging.

There is no fixed input-size limit because files are processed locally rather than uploaded. The practical limit depends on available system memory and browser WebAssembly constraints. As a reference, the approximately 6 GB HG002 diploid human genome uses about 830 MB of browser memory at the default settings.

![](../web/public/tutorial_images/landing_page.png)

To get started, simply drop one or more plain, gzip-compressed, or BGZF FASTA assembly files on the landing-page target, or use its file chooser. The same target also accepts optional BED, GFF3, or GTF annotations and automatically routes each file by type. BGZF is detected from its header even when the suffix is `.gz`. For indexed loading, include `sample.fa.fai` with `sample.fa`, or include both `sample.fa.gz.fai` and `sample.fa.gz.gzi` with a BGZF `sample.fa.gz`:

![](../web/public/tutorial_images/accepted_files.png)

Alternatively, paste a direct HTTPS link ending in `.fa`, `.fasta`, `.fna`, or `.fas` (optionally followed by `.gz`) into **Insert URL** below the drop target and select **Load URL**. The browser streams the response directly through the same local parser and gzip decompressor used for selected files; it does not send the FASTA through the ModDotPlot Browser host. The remote server must permit cross-origin browser requests (CORS), and it can observe normal request metadata such as your IP address. Redirects are supported when every destination uses HTTPS.

For URL imports, ModDotPlot automatically checks for standard companion indexes beside the assembly: `<fasta-url>.fai` for plain FASTA, or both `<fasta-url>.fai` and `<fasta-url>.gzi` for BGZF FASTA. When the host exposes those files and supports HTTP byte ranges, the sequence list opens from the small indexes and only the selected records are streamed on demand. This is strongly recommended for multi-gigabyte human assemblies. Without compatible indexes, URL loading falls back to streaming and parsing the complete file.

ModDotPlot will index and validate the provided assembly or streamed URL and, upon completion, create an `Explore` button that launches the interactive browser. An annotation file selected with the assembly is matched against every loaded sequence after the first plot opens. Make sure annotation sequence identifiers match the corresponding FASTA headers.

![](../web/public/tutorial_images/explore.png)

The following tutorial uses the *Arabidopsis thaliana* Col-CEN v1.2 genome assembly
from [Naish *et al.* 2021](https://doi.org/10.1126/science.abi7489). Select the
*Arabidopsis thaliana* example button to stream that FASTA from the
[Schatz lab Col-CEN release](https://github.com/schatzlab/Col-CEN/tree/main/v1.2).

![](../web/public/tutorial_images/self-similarity_level1.png)

## Plot Navigation

To navigate an interactive plot:

- Scroll with a mouse wheel or trackpad to zoom around the pointer.
- Click and drag to pan across the plot.
- Select `Reset view` to return to the complete plot, and `Clear` to return back to the landing page.

Zooming is limited to a minimum visible interval of approximately 100 bp on each eligible axis. At the closest zoom levels, the browser switches to exact *k*-mer rendering and colors matching cells by nucleotide base.

![](../web/public/tutorial_images/kmer_coloring.png)

Hovering over a plot displays the X and Y sequence names, genomic intervals, and estimated identity for the cell beneath the pointer. Cursor guide lines can be configured or disabled in `Advanced options`.

Press `R` while hovering over an interactive plot to anchor a cross ruler at the current position. Subsequent hover readouts show signed X and Y genomic distances from that anchor, which is useful for measuring arrays, duplications, and other structures. Press `R` again to remove the ruler and restore absolute coordinates.

![](../web/public/tutorial_images/ruler.png)

`ModDotPlot Browser` supports three plot modes when multiple sequences are available:

### Self Plot  
![](../web/public/tutorial_images/self-similarity-final.png)
Default self plot view compares one selected sequence against itself.
### Pairwise Plot 
![](../web/public/tutorial_images/pairwise.png)
Compares two different sequences. Use the X and Y selectors to control which sequence appears on each axis.
### Grid plot 
![](../web/public/tutorial_images/grid.png)
Displays between two and six selected sequences. Self-comparisons appear along the diagonal running from the bottom left to the top right, while the remaining cells contain pairwise comparisons. 

Select any cell to open it as a full interactive Self or Pairwise plot. Use the `Back to grid` button to return to the completed grid. Grid order can be changed by dragging a sequence label on either axis; changing one axis updates the other so that corresponding self-comparisons remain on the diagonal.

## Plot Resolution

Each pixel along an axis corresponds to a genomic interval of a given length, called the *window size* ($w$). Let $n$ be the chromosome length in base pairs and $r$ be the number of pixels spanning the chromosome along that axis. The window size is computed through the following formula:

$$
w = \frac{n}{r}
$$

A higher display resolution therefore corresponds to a smaller window size, with fewer base pairs represented by each pixel. `ModDotPlot Browser` has a default resolution of 1,000 × 1,000. While the window size cannot be modified directly, the resolution can be changed in the advanced settings panel:

![](../web/public/tutorial_images/resolution.png)

Rendering at a higher resolution requires more computation and memory. Because the number of cells grows with the square of the resolution, doubling both plot dimensions creates approximately four times as many cells. High and Ultra settings should therefore be used cautiously with large sequences, large grids, or computers with limited memory.

- $r = 500$ (250,000 cells, approximately 420 MB of memory) ![](../web/public/tutorial_images/500.png)
- $r = 4,000$ (16 million cells, approximately 1.16 GB of memory) ![](../web/public/tutorial_images/4000.png)

Additional non-aesthetic settings are available under `Advanced options`:

- **Quick-view accuracy** controls the sketch size used to generate the first responsive preview.
- **Detailed accuracy** controls the sketch size used for the refined result.
- ***K*-mer length** changes the *k*-mer size used in similarity estimation. Only odd values are allowed to prevent palindromes.

Increasing Quick-view or Detailed accuracy can improve estimator stability but requires more processing time and memory. Changing the *k*-mer length changes the scientific comparison itself and should be done deliberately.

## Plot Customization

The controls beside the plot can be used to change its appearance without reloading the input assembly.

The `Color` control provides two display modes:

- **Similarity** colors cells by estimated sequence identity (ANI).
- **Direction** distinguishes forward (blue) and reverse-orientation (pink) matches. Color intensity reflects the estimated identity.

![](../web/public/tutorial_images/direction.png)

The plot background can be switched between white and black. Under `Identity colors`, the palette selector contains Blues, Greens, Reds, and Greys; Paired, Pastel1, and Pastel2; BrBG, PuOr, and RdGy; plus Spectral and Viridis. Viridis on black is the default.

The identity color controls can be used to:

- Select the number of distinct palette colors.
- Reverse the palette with the `Flip` button.
- Adjust the minimum, midpoint, and maximum displayed identity values.
- Select an individual color swatch and replace it using a color picker or hexadecimal color code.

![](../web/public/tutorial_images/color-wheel.png)

Adjusting these controls changes how the calculated values are displayed; it does not change the underlying similarity calculation.

The `Feature tracks` panel can display the following computed tracks on the X axis, Y axis, or both:

- **GC%:** average GC content in each visible genomic window.
- **CpG O/E:** observed-to-expected CpG ratio, displayed on a 0–2 scale.

BED, GFF3, and GTF annotation files can also be added from the landing page or with the `Add track` button. Plain-text, gzip-compressed, and BGZF-compressed annotations are supported. A multi-sequence annotation file is represented by one logical track, and features are automatically matched to the sequence currently displayed on each axis.

Use the `Track placement` controls to display X-axis tracks above or below the plot and Y-axis tracks to its left or right. The selected placement applies to computed and imported feature tracks.
Computed bins and imported features beneath the current plot cursor are highlighted on
their respective X or Y track.

Select `Export image` to save a high-quality rendering of the current interactive view. *Please do not use plots generated this way for official publications; use the validated [ModDotPlot CLI](https://github.com/marbl/ModDotPlot) instead.* Depending on browser support and the selected filename extension, plots can be exported as PNG, SVG, or PDF. Image exports include the visible axes, sequence labels, feature tracks, and legend. SVG and PDF exports retain vector axes, labels, tracks, and legends around the rasterized heatmap.

## Exporting a config for ModDotPlot CLI

As a reminder, ***this browser is meant for exploratory analysis only!*** Once you have styled a plot to your liking, select `Export ModDotPlot config` to download `moddotplot_config.json` for use in the [ModDotPlot CLI](https://github.com/marbl/ModDotPlot). The config records browser display settings only; add the original FASTA inputs when running it with the CLI.

![](../web/public/tutorial_images/export_mdp.png)

The exported config can then be run with the official ModDotPlot CLI after adding
the original input paths required for the analysis:
```bash
moddotplot -c moddotplot_config.json -f fasta(s).fa
```

![](../web/public/tutorial_images/Chr1_TRI.png)
![](../web/public/tutorial_images/Chr1_HIST.png)

For a Grid plot, use the same config with the CLI's grid-only mode and appropriate
input paths:

```bash
moddotplot --grid-only -c moddotplot_config.json <input options>
```
