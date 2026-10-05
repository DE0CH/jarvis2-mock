Pod::Spec.new do |s|
  s.name           = 'SopsVault'
  s.version        = '1.0.0'
  s.summary        = 'Decrypts sops values with a Secure Enclave P-256 key (age1tag1 recipient)'
  s.author         = 'DE0CH'
  s.homepage       = 'https://github.com/DE0CH/claude-env'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '*.swift'
end
