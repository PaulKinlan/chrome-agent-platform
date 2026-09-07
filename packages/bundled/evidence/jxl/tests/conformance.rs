use jxl_oxide::JxlImage;

#[test]
fn test_decode_small8_lossless() {
    let jxl_bytes = include_bytes!("../fixtures/small8.jxl");
    let ref_png_bytes = include_bytes!("../fixtures/small8.png");

    let image = JxlImage::builder().read(std::io::Cursor::new(jxl_bytes)).expect("read jxl");
    let render = image.render_frame(0).expect("render frame");
    let mut stream = render.stream();
    let width = stream.width();
    let height = stream.height();
    let channels = stream.channels();

    assert_eq!(width, 128);
    assert_eq!(height, 128);
    assert_eq!(channels, 3);

    let total_samples = (width as usize) * (height as usize) * (channels as usize);
    let mut decoded_buf = vec![0u8; total_samples];
    let written = stream.write_to_buffer(&mut decoded_buf);
    assert_eq!(written, total_samples);

    // Read reference PNG
    let decoder = png::Decoder::new(std::io::Cursor::new(ref_png_bytes));
    let mut reader = decoder.read_info().expect("png read info");
    let mut ref_buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut ref_buf).expect("png next frame");

    assert_eq!(info.width, width);
    assert_eq!(info.height, height);
    assert_eq!(info.color_type, png::ColorType::Rgb);
    assert_eq!(info.bit_depth, png::BitDepth::Eight);

    assert_eq!(decoded_buf, &ref_buf[..total_samples], "Decoded pixels must match reference PNG exactly");
}
