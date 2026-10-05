# Adds the end-to-end UI test target (e2e/JarvisUITests) to the Xcode project `expo prebuild` generates,
# and makes it the scheme's only test. Run by ios/ci_scripts/ci_post_clone.sh after prebuild; the native
# project is generated every build and never committed. Uses the xcodeproj gem (CocoaPods depends on it).
#   ruby scripts/add-ui-tests.rb            (from the app directory)
require "xcodeproj"
require "fileutils"

root = File.expand_path("..", __dir__)
ios = File.join(root, "ios")
src = File.join(root, "e2e", "JarvisUITests")
dst = File.join(ios, "JarvisUITests")
FileUtils.rm_rf(dst)
FileUtils.cp_r(src, dst)

path = File.join(ios, "Jarvis.xcodeproj")
project = Xcodeproj::Project.open(path)
app = project.targets.find { |t| t.name == "Jarvis" } or abort "no Jarvis target"
project.targets.select { |t| t.name == "JarvisUITests" }.each(&:remove_from_project)

deploy = app.build_configurations.first.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] || "16.4"
t = project.new_target(:ui_test_bundle, "JarvisUITests", :ios, deploy, nil, :swift)
# new_target links an SDK-pinned Foundation.framework reference; the test needs none of it
t.frameworks_build_phase.files.dup.each { |f| f.remove_from_project }
group = project.main_group.new_group("JarvisUITests", "JarvisUITests")
t.add_file_references([group.new_file("JarvisE2ETests.swift")])
t.resources_build_phase.add_file_reference(group.new_file("CISecrets.json"))
t.add_dependency(app)
t.build_configurations.each do |c|
  s = c.build_settings
  # Expo's project sets no PRODUCT_NAME default: without it the bundle is built as "-Runner.app/PlugIns/.xctest"
  # and xcodebuild fails with "Multiple commands produce …/.xctest"
  s["PRODUCT_NAME"] = "$(TARGET_NAME)"
  s["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks"]
  s["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.de0ch.jarvis.JarvisUITests"
  s["TEST_TARGET_NAME"] = "Jarvis"
  s["DEVELOPMENT_TEAM"] = app.build_configurations.first.build_settings["DEVELOPMENT_TEAM"] || "S64YL394S3"
  s["CODE_SIGN_STYLE"] = "Automatic"
  s["GENERATE_INFOPLIST_FILE"] = "YES"
  s["SWIFT_VERSION"] = "5.0"
  s["TARGETED_DEVICE_FAMILY"] = "1,2"
  s["IPHONEOS_DEPLOYMENT_TARGET"] = deploy
end
project.save

# the shared scheme: build the app, test with JarvisUITests only (prebuild's template names a
# JarvisTests target that does not exist)
scheme_path = File.join(path, "xcshareddata", "xcschemes", "Jarvis.xcscheme")
scheme = Xcodeproj::XCScheme.new(scheme_path)
scheme.test_action.testables.dup.each { |x| scheme.test_action.xml_element.elements["Testables"].delete_element(x.xml_element) }
scheme.test_action.add_testable(Xcodeproj::XCScheme::TestAction::TestableReference.new(t))
# a Debug build loads its JavaScript from a Metro dev server, which CI doesn't have: test the Release
# build, which carries the bundle (the same build the archive ships)
scheme.test_action.build_configuration = "Release"
scheme.save_as(path, "Jarvis", true)
puts "add-ui-tests: JarvisUITests added to #{path}"
