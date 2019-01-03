{
  'targets': [
    {
      'target_name': 'spectator_internals',
      'dependencies': [],
      'sources': ["<!@(ls -1 internals/*.cc)"],
      'include_dirs' : [
        "<!(node -e \"require('nan')\")"
      ],
      'conditions': [
        [ 'OS=="mac"', {
          'xcode_settings': {
            'OTHER_CPLUSPLUSFLAGS' : ['-stdlib=libc++', '-v', '-std=c++11', '-Wall', '-Wextra', '-Wno-unused-parameter', '-g', '-O2' ],
            'OTHER_LDFLAGS': ['-stdlib=libc++'], 
            'MACOSX_DEPLOYMENT_TARGET': '10.12',
            'GCC_ENABLE_CPP_EXCEPTIONS': 'NO'
          }
        }],
        ['OS=="linux"', {
          'cflags': ['-std=c++11', '-Wall', '-Wextra', '-Wno-unused-parameter', '-g', '-O2' ]
        }]
      ]
    }
  ]
}

